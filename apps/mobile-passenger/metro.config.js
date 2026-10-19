// Metro detecta el monorepo (pnpm) a partir de la configuración por defecto de Expo.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
