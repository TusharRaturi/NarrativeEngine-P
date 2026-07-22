import type { LocalePack } from '../types';

/**
 * Korean.
 *
 * Status: AWAITING TRANSLATION. The handful of entries below are seeds so the
 * wiring is visibly working end-to-end — a translator should verify them along
 * with everything else. Every key not listed here falls back to English
 * automatically; that is expected and the app stays fully usable.
 *
 * To contribute: see docs/TRANSLATING.md.
 */
export const ko: LocalePack = {
    code: 'ko',
    label: '한국어',

    /**
     * Korean has no letter case, so `uppercase` on chrome labels does nothing,
     * and the wide letter-spacing the English chrome uses makes Hangul read as
     * broken. Both are cancelled here rather than in any component.
     */
    styleProfile: {
        caps: 'flat',
        tracking: 'tight',
    },

    strings: {
        'hub.delete.cancel': '취소',
        'hub.delete.confirmAction': '삭제',
        'header.settings.label': '설정',
    },
};
