import type { PanelBody } from '../../shared/messages';
import type { Reference } from '../../shared/model';

const sameReferences = (
  left: readonly Reference[],
  right: readonly Reference[],
) =>
  left.length === right.length &&
  left.every((ref, index) => {
    const other = right[index];

    return (
      other !== undefined &&
      ref.id === other.id &&
      ref.name === other.name &&
      ref.kind === other.kind &&
      ref.sha === other.sha &&
      ref.remote === other.remote &&
      ref.tracking?.upstream === other.tracking?.upstream &&
      ref.tracking?.ahead === other.tracking?.ahead &&
      ref.tracking?.behind === other.tracking?.behind
    );
  });

/** Row appends and ancestry updates retain the last authoritative reference snapshot. */
export class ReferencePublications {
  private previous: {
    id: string;
    generation: number;
    refs: Reference[];
  } | null = null;

  prepare(body: PanelBody, id: string, generation: number) {
    const refs =
      body.kind === 'references'
        ? body.references
        : body.kind === 'history'
          ? body.page.refs
          : body.kind === 'history-enrichment'
            ? body.enrichment.refs
            : undefined;
    const same =
      refs !== undefined &&
      this.previous?.id === id &&
      this.previous.generation === generation &&
      sameReferences(this.previous.refs, refs);
    let value = body;

    if (same && body.kind === 'history') {
      const { refs, ...page } = body.page;

      void refs;

      value = { ...body, page };
    } else if (same && body.kind === 'history-enrichment') {
      const { refs, ...enrichment } = body.enrichment;

      void refs;

      value = { ...body, enrichment };
    }

    return {
      body: value,
      commit: () => {
        if (refs === undefined || same) return;
        this.previous = { id, generation, refs: structuredClone(refs) };
      },
    };
  }
}
