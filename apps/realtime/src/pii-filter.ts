/**
 * Chat pasajero–conductor: se ocultan teléfonos, correos y enlaces para que nadie salga de la plataforma
 * con los datos del otro (y para dificultar el phishing). No pretende ser perfecto: es una barrera de higiene.
 */
export function redactPii(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[correo oculto]')
    .replace(/(https?:\/\/|www\.)\S+/gi, '[enlace oculto]')
    .replace(/(\+?\d[\d\s().-]{6,}\d)/g, '[número oculto]');
}
