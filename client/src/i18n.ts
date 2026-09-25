import ptBR from "../../locales/pt-BR.json";
import enUS from "../../locales/en-US.json";

type LocaleMessages = Record<string, string>;
type LocaleId = "pt-BR" | "en-US";

const locales: Record<LocaleId, LocaleMessages> = { "pt-BR": ptBR, "en-US": enUS };
let activeLocale: LocaleId = "pt-BR";

export function setLocale(locale: LocaleId): void {
  activeLocale = locale;
  document.documentElement.lang = locale;
  applyTranslations();
}

export function t(key: string, values: Record<string, string | number> = {}): string {
  let message = locales[activeLocale][key] ?? locales["pt-BR"][key] ?? key;
  for (const [name, value] of Object.entries(values)) message = message.replaceAll(`{${name}}`, String(value));
  return message;
}

export function applyTranslations(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n || "");
  });
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-i18n-placeholder]").forEach((element) => {
    element.placeholder = t(element.dataset.i18nPlaceholder || "");
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel || ""));
  });
}

document.documentElement.lang = activeLocale;
applyTranslations();
