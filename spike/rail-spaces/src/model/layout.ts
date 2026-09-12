export type ConvId = string;
export type SpaceId = string;

export type Space = { id: SpaceId; name: string; parent: SpaceId | null };

export type Placement = { conv: ConvId; space: SpaceId; drawn: boolean };

/** The layout as it travels: spaces in sibling order, placements in placement
 *  order. Both orders are the array order, so no position field can disagree
 *  with the sequence it describes. */
export type LayoutSnapshot = { spaces: Space[]; placements: Placement[] };

export type RailScope = 'all' | 'space' | 'unplaced';

/** Case-insensitive substring of the id, verbatim: the same rule the rail's
 *  existing id box uses. A title says what a conversation is about; an id says
 *  which one it is. */
export function idMatches(conv: ConvId, query: string): boolean {
  return conv.toLowerCase().includes(query.toLowerCase());
}

export class Layout {
  /** Sibling order is array order; `parent` carries the nesting. */
  #spaces: Space[] = [];
  /** Keyed by conversation, which is what makes one space per conversation
   *  structural. Placement order within a space is this map's order. */
  #placements = new Map<ConvId, Placement>();

  #shown: SpaceId | null = null;
  #scope: RailScope = 'all';
  #search = '';

  constructor(snapshot: LayoutSnapshot = { spaces: [], placements: [] }) {
    this.apply(snapshot);
  }

  /** Fold a whole layout, replacing what was held. Tolerant, because this is
   *  what arrives from elsewhere: an unknown parent reads as top level rather
   *  than hiding the space, a placement naming a space that isn't here is
   *  dropped, and a conversation named twice keeps its last placement. */
  apply(snapshot: LayoutSnapshot): void {
    const ids = new Set(snapshot.spaces.map((s) => s.id));
    this.#spaces = snapshot.spaces.map((s) => ({
      id: s.id,
      name: s.name,
      parent: s.parent !== null && ids.has(s.parent) ? s.parent : null,
    }));
    this.#placements = new Map();
    for (const p of snapshot.placements) {
      if (!ids.has(p.space)) continue;
      this.#placements.delete(p.conv);
      this.#placements.set(p.conv, { conv: p.conv, space: p.space, drawn: p.drawn });
    }
    if (this.#shown !== null && !ids.has(this.#shown)) this.#shown = null;
  }

  /** What a client sends: the layout, never its own view of it. */
  snapshot(): LayoutSnapshot {
    return {
      spaces: this.#spaces.map((s) => ({ ...s })),
      placements: [...this.#placements.values()].map((p) => ({ ...p })),
    };
  }

  createSpace(id: SpaceId, name: string, parent: SpaceId | null = null): void {
    this.#spaces.push({ id, name, parent });
  }

  renameSpace(id: SpaceId, name: string): void {
    const space = this.#spaces.find((s) => s.id === id);
    if (space !== undefined) space.name = name;
  }

  /** Deleting a space releases everything in it: the conversations become
   *  unplaced, and a space held inside it goes with it, releasing its own. Only
   *  the arrangement is lost. */
  deleteSpace(id: SpaceId): void {
    const going = new Set<SpaceId>();
    const pending = [id];
    while (pending.length > 0) {
      const next = pending.pop() as SpaceId;
      if (going.has(next)) continue;
      going.add(next);
      for (const child of this.#spaces) if (child.parent === next) pending.push(child.id);
    }
    this.#spaces = this.#spaces.filter((s) => !going.has(s.id));
    for (const [conv, p] of this.#placements) if (going.has(p.space)) this.#placements.delete(conv);
    if (this.#shown !== null && going.has(this.#shown)) this.#shown = null;
  }

  /** Put a conversation in a space, which takes it out of wherever it was:
   *  one placement per conversation. Placing into the space it already sits in
   *  keeps its position and draws it. */
  place(conv: ConvId, space: SpaceId): void {
    if (!this.#spaces.some((s) => s.id === space)) return;
    const held = this.#placements.get(conv);
    if (held?.space === space) {
      held.drawn = true;
      return;
    }
    this.#placements.delete(conv);
    this.#placements.set(conv, { conv, space, drawn: true });
  }

  unplace(conv: ConvId): void {
    this.#placements.delete(conv);
  }

  /** The one gesture that files and unfiles: in this space already, it comes
   *  out; anywhere else or nowhere, it goes in. */
  togglePlacement(conv: ConvId, space: SpaceId): void {
    if (this.#placements.get(conv)?.space === space) this.unplace(conv);
    else this.place(conv, space);
  }

  /** Stop drawing it without taking it out of its space. */
  minimise(conv: ConvId): void {
    const held = this.#placements.get(conv);
    if (held !== undefined) held.drawn = false;
  }

  restore(conv: ConvId): void {
    const held = this.#placements.get(conv);
    if (held !== undefined) held.drawn = true;
  }

  showSpace(space: SpaceId | null): void {
    if (space !== null && !this.#spaces.some((s) => s.id === space)) return;
    this.#shown = space;
  }

  /** Go to where a conversation lives, changing nothing else. A conversation
   *  living nowhere has nowhere to go, and this reports that rather than
   *  inventing somewhere. */
  goTo(conv: ConvId): boolean {
    const held = this.#placements.get(conv);
    if (held === undefined) return false;
    this.#shown = held.space;
    return true;
  }

  setScope(scope: RailScope): void {
    this.#scope = scope;
  }

  setSearch(search: string): void {
    this.#search = search;
  }

  get spaces(): Space[] {
    return this.#spaces.map((s) => ({ ...s }));
  }

  children(parent: SpaceId | null): Space[] {
    return this.#spaces.filter((s) => s.parent === parent).map((s) => ({ ...s }));
  }

  nameOf(space: SpaceId): string | undefined {
    return this.#spaces.find((s) => s.id === space)?.name;
  }

  get shownSpace(): SpaceId | null {
    return this.#shown;
  }

  get railScope(): RailScope {
    return this.#scope;
  }

  get searchText(): string {
    return this.#search;
  }

  placementOf(conv: ConvId): Placement | undefined {
    const held = this.#placements.get(conv);
    return held === undefined ? undefined : { ...held };
  }

  /** Where a conversation lives, or nowhere. */
  spaceOf(conv: ConvId): SpaceId | null {
    return this.#placements.get(conv)?.space ?? null;
  }

  /** Placed directly in this space, in placement order. A space held inside it
   *  keeps its own; nesting is not containment of placements. */
  placedIn(space: SpaceId): ConvId[] {
    return [...this.#placements.values()].filter((p) => p.space === space).map((p) => p.conv);
  }

  drawnIn(space: SpaceId): ConvId[] {
    return [...this.#placements.values()].filter((p) => p.space === space && p.drawn).map((p) => p.conv);
  }

  minimisedIn(space: SpaceId): ConvId[] {
    return [...this.#placements.values()].filter((p) => p.space === space && !p.drawn).map((p) => p.conv);
  }

  /** The panels: what the shown space draws, tiled, in placement order. */
  get drawn(): ConvId[] {
    return this.#shown === null ? [] : this.drawnIn(this.#shown);
  }

  get minimised(): ConvId[] {
    return this.#shown === null ? [] : this.minimisedIn(this.#shown);
  }

  /** Subscription follows what is drawn, not what is placed. */
  get subscribed(): ConvId[] {
    return this.drawn;
  }

  /** The rail's own slice. `register` is every conversation there is;
   *  `visible` is what the rail's other filters have left of it. An id search
   *  answers "which one is it", so it reaches past the scope AND past those
   *  filters rather than composing with either: that is why the whole register
   *  has to come in alongside the filtered list. */
  railRows(register: readonly ConvId[], visible: readonly ConvId[] = register): ConvId[] {
    if (this.#search !== '') return register.filter((c) => idMatches(c, this.#search));
    if (this.#scope === 'unplaced') return visible.filter((c) => !this.#placements.has(c));
    if (this.#scope === 'space')
      return this.#shown === null ? [] : visible.filter((c) => this.spaceOf(c) === this.#shown);
    return [...visible];
  }
}
