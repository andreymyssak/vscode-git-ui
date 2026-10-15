import type { RepositoryInfo } from '../../shared/model';

export const refreshSections = ['changes', 'stashes', 'operation'] as const;
export type RefreshSection = (typeof refreshSections)[number];
export type RefreshTargets = ReadonlyMap<string, ReadonlySet<RefreshSection>>;

/** Events revoke only their affected reads; the debounce never delays invalidation. */
export class SourceControlRefreshes {
  private all = false;
  private sequence = 0;
  private readonly dirty = new Map<string, Set<RefreshSection>>();
  private readonly owners = new Map<
    string,
    Map<RefreshSection, AbortController>
  >();

  queue(
    id?: string,
    sections: readonly RefreshSection[] = refreshSections,
  ): void {
    this.invalidate(id, sections);
    if (id === undefined) this.all = true;
    else {
      const pending = this.dirty.get(id) ?? new Set<RefreshSection>();

      for (const section of sections) pending.add(section);
      this.dirty.set(id, pending);
    }
  }

  take(infos: RepositoryInfo[], known: ReadonlySet<string>): RefreshTargets {
    const targets = new Map<string, ReadonlySet<RefreshSection>>();

    for (const info of infos) {
      if (this.all || !known.has(info.id))
        targets.set(info.id, new Set(refreshSections));
      else {
        const sections = this.dirty.get(info.id);

        if (sections) targets.set(info.id, sections);
      }
    }

    this.all = false;
    this.dirty.clear();

    return targets;
  }

  begin(id: string, section: RefreshSection) {
    const owners =
      this.owners.get(id) ?? new Map<RefreshSection, AbortController>();

    owners.get(section)?.abort();
    const owner = new AbortController();

    owners.set(section, owner);
    this.owners.set(id, owners);

    return {
      signal: owner.signal,
      generation: ++this.sequence,
      current: () => owners.get(section) === owner && !owner.signal.aborted,
      finish: () => {
        if (owners.get(section) === owner) owners.delete(section);
        if (!owners.size && this.owners.get(id) === owners)
          this.owners.delete(id);
      },
    };
  }

  invalidate(
    id?: string,
    sections: readonly RefreshSection[] = refreshSections,
  ): void {
    for (const [key, owners] of this.owners) {
      if (id !== undefined && id !== key) continue;
      for (const section of sections) {
        owners.get(section)?.abort();
        owners.delete(section);
      }

      if (!owners.size) this.owners.delete(key);
    }
  }
}
