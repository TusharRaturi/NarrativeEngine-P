# Translating Narrative Engine

Thank you — genuinely. This page is everything you need. There is one file to
edit, no translation tools to install, and no account to create.

**You do not have to finish.** Anything you leave untranslated shows in English.
A half-finished translation is a perfectly good contribution and ships fine.

---

## 1. Find your file

Translations live in `src/i18n/locales/`:

| Language | File |
| :-- | :-- |
| English (the source — do not edit) | `en.ts` |
| Korean | `ko.ts` |
| Russian | `ru.ts` |

If your language is not there, copy `ko.ts` to a new file (for example
`ja.ts` for Japanese) and open an issue — a maintainer adds one line to register
it.

## 2. Edit it

Each entry is `'key': 'text'`. **Translate the text on the right. Never change
the key on the left.**

```ts
strings: {
    'hub.delete.cancel': '취소',
    'header.settings.label': '설정',
},
```

To translate a new string, copy the line from `en.ts` and replace the English:

```ts
// en.ts has:
'header.exit.label': 'Exit',

// so in ko.ts you add:
'header.exit.label': '나가기',
```

That is the entire job. Add as many as you like, in any order.

### Things in `{{double braces}}` must survive

`{{name}}`, `{{count}}`, `{{version}}` are slots the app fills in at runtime.
Keep them exactly as written — you may move them anywhere in the sentence, which
is often necessary for word order.

```ts
// en.ts
'header.version.tooltip': 'Narrative Engine version {{version}}',

// fine — moved, still intact
'header.version.tooltip': 'Narrative Engine 버전 {{version}}',

// broken — the slot is gone, users will see the raw text
'header.version.tooltip': 'Narrative Engine 버전',
```

### Counting things (plurals)

Some keys come in variants ending `.one`, `.few`, `.many`, `.other`. Use the set
your language actually needs — the app picks the right one for the number.

- **Korean** has no plural agreement: `.other` alone is enough.
- **Russian** needs `.one` (1, 21, 31…), `.few` (2–4), `.many` (5+, 11–14).

```ts
'settings.language.untranslated.one': '{{count}} строка ещё на английском.',
'settings.language.untranslated.few': '{{count}} строки ещё на английском.',
'settings.language.untranslated.many': '{{count}} строк ещё на английском.',
```

If you supply only `.other`, it is used for every number — good enough to start.

## 3. Check your work

```bash
npm run i18n:check
```

It prints your coverage and flags the two mistakes that matter: keys that no
longer exist, and dropped `{{placeholders}}`. Untranslated keys are listed but
are **not** errors.

To see it in the app: **Settings → Global → Interface Language**. The picker
also shows how many strings are still in English.

## 4. Send it back

Open a pull request with just your locale file, or email the file if that is
easier. Both are fine.

---

## Making it look right, not just read right

The interface was designed around English, and some of that does not carry over.
If your language looks cramped, clipped, or oddly spaced, **it is not your
translation's fault** — say so and it gets fixed properly.

Each locale file can declare visual corrections at the top:

```ts
styleProfile: {
    caps: 'flat',      // cancel ALL-CAPS — Korean has no letter case
    tracking: 'tight', // cancel the wide letter-spacing
},
```

Korean already sets both. Russian tightens spacing only, because Cyrillic does
have capitals. If your language needs something else, mention it in your PR.

If text overflows its button, that is a layout bug in the app, not something to
solve by shortening your translation. Report it.

---

## Two things to know

**Do not translate the story.** This file is menus and buttons only. What the
game master *writes* is a separate feature that is not built yet, and it is not
affected by anything here.

**Your work will not be thrown away by a rename.** The keys on the left are
frozen. If one ever has to change, `npm run i18n:check` tells you exactly which
line to update.

## Questions

Open an issue. "I don't understand what this string means" is a good issue — if
the English is ambiguous to you, it is ambiguous to users too.
