// Config plugin: política de red de Android (network_security_config.xml).
// - Producción: sin tráfico en claro y con certificate pinning (pins por variables de entorno de la build).
// - Desarrollo: permite HTTP solo hacia los hosts indicados (localhost con `adb reverse`, o la IP de la PC).
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

const esc = (s) => String(s).replace(/[<>&"]/g, '');

function xml({ cleartextHosts, pinDomains, pins, pinExpiration }) {
  const cleartext = cleartextHosts.length
    ? `  <domain-config cleartextTrafficPermitted="true">\n${cleartextHosts.map((h) => `    <domain includeSubdomains="false">${esc(h)}</domain>`).join('\n')}\n  </domain-config>\n`
    : '';
  const pinned = pinDomains.length && pins.length
    ? `  <domain-config cleartextTrafficPermitted="false">\n${pinDomains.map((d) => `    <domain includeSubdomains="true">${esc(d)}</domain>`).join('\n')}\n    <pin-set expiration="${esc(pinExpiration)}">\n${pins.map((p) => `      <pin digest="SHA-256">${esc(p)}</pin>`).join('\n')}\n    </pin-set>\n  </domain-config>\n`
    : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generado por plugins/withNetworkSecurity.js: no editar a mano. -->
<network-security-config>
  <base-config cleartextTrafficPermitted="false">
    <trust-anchors><certificates src="system" /></trust-anchors>
  </base-config>
${cleartext}${pinned}</network-security-config>
`;
}

module.exports = function withNetworkSecurity(config, opts) {
  config = withDangerousMod(config, [
    'android',
    async (c) => {
      const dir = path.join(c.modRequest.platformProjectRoot, 'app/src/main/res/xml');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'network_security_config.xml'), xml(opts));
      return c;
    },
  ]);
  return withAndroidManifest(config, (c) => {
    const app = c.modResults.manifest.application[0];
    app.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    // La política la define network_security_config (permite HTTP solo a los hosts de desarrollo).
    app.$['android:usesCleartextTraffic'] = 'false';
    app.$['android:allowBackup'] = 'false';
    app.$['android:fullBackupContent'] = 'false';
    app.$['android:dataExtractionRules'] = '@xml/data_extraction_rules';
    return c;
  });
};

module.exports.withNoBackupRules = function withNoBackupRules(config) {
  return withDangerousMod(config, [
    'android',
    async (c) => {
      const dir = path.join(c.modRequest.platformProjectRoot, 'app/src/main/res/xml');
      fs.mkdirSync(dir, { recursive: true });
      // Android 12+: nada de la app se copia a la nube ni a otro dispositivo (tokens, claves, caché).
      fs.writeFileSync(
        path.join(dir, 'data_extraction_rules.xml'),
        `<?xml version="1.0" encoding="utf-8"?>\n<data-extraction-rules>\n  <cloud-backup><exclude domain="root" /><exclude domain="file" /><exclude domain="database" /><exclude domain="sharedpref" /></cloud-backup>\n  <device-transfer><exclude domain="root" /><exclude domain="file" /><exclude domain="database" /><exclude domain="sharedpref" /></device-transfer>\n</data-extraction-rules>\n`,
      );
      return c;
    },
  ]);
};
