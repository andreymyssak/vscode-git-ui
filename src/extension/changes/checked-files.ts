/** Inclusion belongs to paths, independently of Git staging. */
export class CheckedFiles<T extends { path: string }> {
  private files: readonly T[] = [];
  private readonly checked = new Set<string>();

  refresh(files: readonly T[]): void {
    this.files = files;
    const surviving = new Set(files.map((file) => file.path));

    for (const path of this.checked)
      if (!surviving.has(path)) this.checked.delete(path);
  }

  selected(): T[] {
    return this.files.filter((file) => this.checked.has(file.path));
  }

  setFile(path: string, checked: boolean): void {
    if (checked && this.files.some((file) => file.path === path))
      this.checked.add(path);
    else this.checked.delete(path);
  }

  clear(paths: readonly string[]): void {
    for (const path of paths) this.checked.delete(path);
  }
}
