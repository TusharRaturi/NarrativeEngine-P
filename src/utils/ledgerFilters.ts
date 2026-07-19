import type { NPCEntry, LocationEntry } from '../types';

export type SortOrder = 'none' | 'az' | 'za';

function applySort<T extends { name: string }>(list: T[], order: SortOrder): T[] {
    if (order === 'az') return [...list].sort((a, b) => a.name.localeCompare(b.name));
    if (order === 'za') return [...list].sort((a, b) => b.name.localeCompare(a.name));
    return list;
}

export function filterNPCs(npcs: NPCEntry[], query: string, order: SortOrder = 'none'): NPCEntry[] {
    let list = npcs;
    if (query.trim()) {
        const q = query.toLowerCase();
        list = list.filter(n =>
            n.name.toLowerCase().includes(q) ||
            n.aliases?.toLowerCase().includes(q) ||
            n.faction?.toLowerCase().includes(q)
        );
    }
    return applySort(list, order);
}

export function filterLocations(locations: LocationEntry[], query: string): LocationEntry[] {
    let list = locations;
    if (query.trim()) {
        const q = query.toLowerCase();
        list = list.filter(l =>
            l.name.toLowerCase().includes(q) ||
            l.aliases?.toLowerCase().includes(q) ||
            l.broadLocation?.toLowerCase().includes(q)
        );
    }
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
}