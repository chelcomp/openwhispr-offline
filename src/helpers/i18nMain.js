const i18next = require("i18next");

const enTranslation = require("../locales/en/translation.json");
const ptTranslation = require("../locales/pt/translation.json");

const enPrompts = require("../locales/en/prompts.json");
const ptPrompts = require("../locales/pt/prompts.json");

const SUPPORTED_UI_LANGUAGES = ["en", "pt"];

function normalizeUiLanguage(language) {
  const candidate = (language || "").trim();

  const normalized = candidate.replace("_", "-");
  const fullMatch = SUPPORTED_UI_LANGUAGES.find(
    (lang) => lang.toLowerCase() === normalized.toLowerCase()
  );
  if (fullMatch) return fullMatch;

  const base = candidate.split("-")[0].split("_")[0].toLowerCase();
  return SUPPORTED_UI_LANGUAGES.includes(base) ? base : "en";
}

const i18nMain = i18next.createInstance();

void i18nMain.init({
  initAsync: false,
  resources: {
    en: {
      translation: enTranslation,
      prompts: enPrompts,
    },
    pt: {
      translation: ptTranslation,
      prompts: ptPrompts,
    },
  },
  lng: normalizeUiLanguage(process.env.UI_LANGUAGE),
  fallbackLng: "en",
  ns: ["translation", "prompts"],
  defaultNS: "translation",
  interpolation: {
    escapeValue: false,
  },
  returnEmptyString: false,
  returnNull: false,
});

function changeLanguage(language) {
  const normalized = normalizeUiLanguage(language);

  if (i18nMain.language !== normalized) {
    void i18nMain.changeLanguage(normalized);
  }

  return normalized;
}

module.exports = {
  i18nMain,
  changeLanguage,
  normalizeUiLanguage,
  SUPPORTED_UI_LANGUAGES,
};
