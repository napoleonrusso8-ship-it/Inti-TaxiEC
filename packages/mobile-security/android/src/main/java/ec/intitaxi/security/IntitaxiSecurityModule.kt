package ec.intitaxi.security

import android.app.Activity
import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Debug
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import android.view.WindowManager
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.IntegrityTokenRequest
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/**
 * Seguridad del dispositivo para Inti Taxi.
 *
 * - Clave DPoP ES256 generada DENTRO de Android Keystore (StrongBox si existe, si no TEE).
 *   La clave privada nunca sale del hardware; JavaScript solo pide firmas.
 * - Play Integrity (API clásica con nonce del servidor): el servidor descifra y evalúa el veredicto.
 * - Passkeys con Credential Manager (requiere dominio con assetlinks.json).
 * - FLAG_SECURE: impide capturas y grabación de pantalla en vistas sensibles.
 * - Señales locales de entorno (depurador, root, emulador, Frida). Son orientativas:
 *   la decisión de confianza la toma el servidor con Play Integrity.
 */
class IntitaxiSecurityModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val currentActivity: Activity
    get() = appContext.currentActivity ?: throw CodedException("ERR_NO_ACTIVITY", "No hay una pantalla activa", null)

  override fun definition() = ModuleDefinition {
    Name("IntitaxiSecurity")

    AsyncFunction("ensureKey") { alias: String ->
      requireAlias(alias)
      val ks = keyStore()
      if (!ks.containsAlias(alias)) generateKey(alias)
      val pub = ks.getCertificate(alias).publicKey as ECPublicKey
      mapOf(
        "kty" to "EC",
        "crv" to "P-256",
        "x" to b64u(unsigned32(pub.w.affineX)),
        "y" to b64u(unsigned32(pub.w.affineY)),
        "hardware" to securityLevel(alias),
      )
    }

    AsyncFunction("sign") { alias: String, dataB64u: String ->
      requireAlias(alias)
      val key = keyStore().getKey(alias, null) as? PrivateKey
        ?: throw CodedException("ERR_NO_KEY", "La clave del dispositivo no existe", null)
      val sig = Signature.getInstance("SHA256withECDSA").run {
        initSign(key)
        update(Base64.decode(dataB64u, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP))
        sign()
      }
      b64u(derToJose(sig))
    }

    AsyncFunction("deleteKey") { alias: String ->
      requireAlias(alias)
      val ks = keyStore()
      if (ks.containsAlias(alias)) ks.deleteEntry(alias)
    }

    AsyncFunction("integrityToken") { nonce: String, cloudProjectNumber: Double?, promise: Promise ->
      val builder = IntegrityTokenRequest.builder().setNonce(nonce)
      if (cloudProjectNumber != null && cloudProjectNumber > 0) builder.setCloudProjectNumber(cloudProjectNumber.toLong())
      IntegrityManagerFactory.create(context.applicationContext)
        .requestIntegrityToken(builder.build())
        .addOnSuccessListener { promise.resolve(it.token()) }
        .addOnFailureListener { promise.reject("ERR_INTEGRITY", it.message ?: "Play Integrity no disponible", it) }
    }

    AsyncFunction("createPasskey") Coroutine { requestJson: String ->
      val activity = currentActivity
      val res = CredentialManager.create(activity).createCredential(activity, CreatePublicKeyCredentialRequest(requestJson))
      (res as? CreatePublicKeyCredentialResponse)?.registrationResponseJson
        ?: throw CodedException("ERR_PASSKEY", "Respuesta de passkey inesperada", null)
    }

    AsyncFunction("getPasskey") Coroutine { requestJson: String ->
      val activity = currentActivity
      val res = CredentialManager.create(activity).getCredential(activity, GetCredentialRequest(listOf(GetPublicKeyCredentialOption(requestJson))))
      (res.credential as? PublicKeyCredential)?.authenticationResponseJson
        ?: throw CodedException("ERR_PASSKEY", "Respuesta de passkey inesperada", null)
    }

    AsyncFunction("setSecureScreen") { enabled: Boolean ->
      val activity = currentActivity
      activity.runOnUiThread {
        if (enabled) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
    }

    Function("environment") {
      val flags = context.applicationInfo.flags
      mapOf(
        "debuggable" to ((flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0),
        "debuggerAttached" to (Debug.isDebuggerConnected() || Debug.waitingForDebugger()),
        "adbEnabled" to (Settings.Global.getInt(context.contentResolver, Settings.Global.ADB_ENABLED, 0) == 1),
        "emulator" to looksLikeEmulator(),
        "suBinary" to SU_PATHS.any { File(it).exists() },
        "hookingFramework" to hookingDetected(),
        "sdkInt" to Build.VERSION.SDK_INT,
      )
    }
  }

  // ---------- Keystore ----------

  private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun requireAlias(alias: String) {
    if (!ALIAS.matches(alias)) throw CodedException("ERR_ALIAS", "Alias inválido", null)
  }

  private fun generateKey(alias: String) {
    fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setIsStrongBoxBacked(strongBox)
      .build()
    val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
    try {
      gen.initialize(spec(true))
      gen.generateKeyPair()
    } catch (e: StrongBoxUnavailableException) {
      gen.initialize(spec(false))
      gen.generateKeyPair()
    }
  }

  @Suppress("DEPRECATION")
  private fun securityLevel(alias: String): String {
    val key = keyStore().getKey(alias, null) as PrivateKey
    val info = KeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java)
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      when (info.securityLevel) {
        KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
        KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
        else -> "software"
      }
    } else if (info.isInsideSecureHardware) "tee" else "software"
  }

  // ---------- Codificación ----------

  private fun b64u(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

  /** Entero sin signo de exactamente 32 bytes (coordenadas y componentes de firma P-256). */
  private fun unsigned32(n: BigInteger): ByteArray {
    val raw = n.toByteArray()
    return when {
      raw.size == 32 -> raw
      raw.size > 32 -> raw.copyOfRange(raw.size - 32, raw.size)
      else -> ByteArray(32 - raw.size) + raw
    }
  }

  /** Firma ECDSA DER (SEQUENCE { r, s }) → formato JWS r‖s de 64 bytes. */
  private fun derToJose(der: ByteArray): ByteArray {
    var i = 2
    if ((der[1].toInt() and 0x80) != 0) i += der[1].toInt() and 0x7f
    if (der[i].toInt() != 0x02) throw CodedException("ERR_SIGNATURE", "Firma inválida", null)
    val rLen = der[i + 1].toInt()
    val r = BigInteger(1, der.copyOfRange(i + 2, i + 2 + rLen))
    i += 2 + rLen
    if (der[i].toInt() != 0x02) throw CodedException("ERR_SIGNATURE", "Firma inválida", null)
    val sLen = der[i + 1].toInt()
    val s = BigInteger(1, der.copyOfRange(i + 2, i + 2 + sLen))
    return unsigned32(r) + unsigned32(s)
  }

  // ---------- Entorno ----------

  private fun looksLikeEmulator(): Boolean =
    Build.FINGERPRINT.startsWith("generic") || Build.FINGERPRINT.contains("emulator") ||
      Build.MODEL.contains("Emulator") || Build.MODEL.contains("sdk_gphone") ||
      Build.HARDWARE.contains("goldfish") || Build.HARDWARE.contains("ranchu") ||
      Build.PRODUCT.contains("sdk")

  private fun hookingDetected(): Boolean = try {
    File("/proc/self/maps").useLines { lines -> lines.any { l -> HOOK_MARKERS.any { l.contains(it, ignoreCase = true) } } }
  } catch (e: Exception) {
    false
  }

  companion object {
    private val ALIAS = Regex("^[a-z0-9._-]{3,64}$")
    private val SU_PATHS = listOf("/system/bin/su", "/system/xbin/su", "/sbin/su", "/system/app/Superuser.apk", "/data/adb/magisk")
    private val HOOK_MARKERS = listOf("frida", "gum-js-loop", "xposed", "substrate", "lsposed")
  }
}
