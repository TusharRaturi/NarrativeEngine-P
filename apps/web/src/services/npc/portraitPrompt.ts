import type { NPCVisualProfile } from '../../types';
import { DEFAULT_VISUAL_PROFILE } from '../../types';

const PORTRAIT_STYLE_MAP: Record<string, string> = {
    'Realistic': 'High quality, highly detailed realistic digital painting, fantasy art style, masterpiece',
    'Anime Realistic': 'Highly detailed anime realistic art style, ala Makoto Shinkai, masterpiece, beautiful lighting',
    'Anime': 'High quality anime art style, ala Kyoto Animation, crisp lines, masterpiece',
    'Western RPG': 'Western RPG art style, character portrait, ala Baldur\'s Gate 3, highly detailed digital painting',
    'Chibi': 'High quality chibi art style, cute, fantasy character portrait, masterpiece'
};

/**
 * Builds the single-subject portrait prompt shared by the per-NPC generator
 * and the bulk "Populate Images" path. Mirrors the original inline prompt
 * verbatim so cached image endpoints keep producing identical results.
 */
export function buildPortraitPrompt(
    vp: NPCVisualProfile | undefined,
    name: string,
    appearance?: string
): string {
    const profile = vp || DEFAULT_VISUAL_PROFILE;
    const appearanceInfo = appearance ? `Legacy Notes: ${appearance} ` : '';
    const style = PORTRAIT_STYLE_MAP[profile.artStyle] || PORTRAIT_STYLE_MAP['Realistic'];
    return `A profile picture portrait of ONE SINGLE PERSON ONLY with a neutral gray background.The character's face, hair, and middle chest are clearly visible. Solo character, no other people, no split screens, no twins. ${style}. Name: ${name}. Race: ${profile.race}. Gender: ${profile.gender}. Age: ${profile.ageRange}. Build: ${profile.build}. Hair: ${profile.hairStyle}. Eyes: ${profile.eyeColor}. Skin: ${profile.skinTone}. Clothing: ${profile.clothing}. Distinctive marks: ${profile.distinctMarks}. ${appearanceInfo}`;
}