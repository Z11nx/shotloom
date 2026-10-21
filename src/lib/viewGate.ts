/**
 * Decides whether an asynchronous response may update the editor.
 *
 * Every film selection gets a new epoch, including switching back to a film
 * seen earlier (A → B → A gives A a fresh epoch). Async work captures a token
 * for the selection that started it; its response is applied only if:
 *   - that selection is still the current one (same film AND same epoch),
 *   - the response is for that film, and
 *   - nothing newer has been applied in this selection.
 *
 * Pure and framework-free so it can be unit tested.
 */
export interface Selection {
  readonly film: string;
  readonly epoch: number;
}

export interface ViewToken extends Selection {
  readonly seq: number;
}

export class ViewGate {
  private current: Selection | null = null;
  private epochCounter = 0;
  private seqCounter = 0;
  private applied = 0;

  /** Starts a new selection session. Always returns a fresh epoch. */
  select(film: string | null): Selection | null {
    this.applied = 0;
    this.current = film === null ? null : { film, epoch: ++this.epochCounter };
    return this.current;
  }

  get selection(): Selection | null {
    return this.current;
  }

  isCurrent(sel: Selection | null | undefined): boolean {
    return !!sel && !!this.current && sel.epoch === this.current.epoch && sel.film === this.current.film;
  }

  /** A token for work started on behalf of `sel` (not necessarily the current selection). */
  token(sel: Selection): ViewToken {
    return { film: sel.film, epoch: sel.epoch, seq: ++this.seqCounter };
  }

  /**
   * Returns true (and records it) if a response for `viewFilm` obtained with
   * `token` may be applied now.
   */
  accept(token: ViewToken, viewFilm: string): boolean {
    if (!this.isCurrent(token)) return false;
    if (viewFilm !== token.film) return false;
    if (token.seq < this.applied) return false;
    this.applied = token.seq;
    return true;
  }
}
