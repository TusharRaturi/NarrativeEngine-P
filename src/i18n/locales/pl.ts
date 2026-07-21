import type { LocalePack } from '../types';

/**
 * Polish.
 *
 * Status: AWAITING TRANSLATION. The handful of entries below are seeds so the
 * wiring is visibly working end-to-end — a translator should verify them along
 * with everything else. Every key not listed here falls back to English
 * automatically; that is expected and the app stays fully usable.
 *
 * Plurals: Polish uses one/few/many, like Russian — `Intl.PluralRules` already
 * selects the right form, so a translator only has to supply the variants.
 * See the plural section of docs/TRANSLATING.md.
 *
 * To contribute: see docs/TRANSLATING.md.
 */
export const pl: LocalePack = {
    code: 'pl',
    label: 'Polski',

    /**
     * Latin script with diacritics, and Polish does have letter case, so the
     * ALL-CAPS chrome is left as authored. Polish words do run longer than
     * English ("Ustawienia" vs "Settings"), so the wide letter-spacing is
     * tightened to buy back width.
     *
     * Revisit once the translation is real: if labels still overflow, fix it in
     * the LANGUAGE OVERRIDES block of src/index.css keyed on [data-lang="pl"] —
     * never in a component, and never by shortening the translation.
     */
    styleProfile: {
        tracking: 'tight',
    },

    strings: {
        'hub.delete.cancel': 'Anuluj',
        'hub.delete.confirmAction': 'Usuń',
        'header.settings.label': 'Ustawienia',
    },
};
