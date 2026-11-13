export interface NoticeMark {
  start: number;
  end: number;
  kind: "quote" | "identifier";
  label: string;
}

function visibleMarks(text: string, marks: readonly NoticeMark[]): NoticeMark[] {
  const sorted = marks
    .filter((mark) => mark.start >= 0 && mark.end > mark.start && mark.end <= text.length)
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const kept: NoticeMark[] = [];
  for (const mark of sorted) {
    if (kept.some((item) => mark.start < item.end && mark.end > item.start)) {
      continue;
    }
    kept.push(mark);
  }
  return kept;
}

export function SourceNoticeReader(props: {
  title: string;
  text: string;
  marks: readonly NoticeMark[];
  testId?: string;
}) {
  const marks = visibleMarks(props.text, props.marks);
  const pieces: Array<{ key: string; text: string; mark: NoticeMark | null }> = [];
  let cursor = 0;
  marks.forEach((mark, index) => {
    if (mark.start > cursor) {
      pieces.push({ key: `t-${cursor}`, text: props.text.slice(cursor, mark.start), mark: null });
    }
    pieces.push({
      key: `m-${index}-${mark.start}`,
      text: props.text.slice(mark.start, mark.end),
      mark,
    });
    cursor = mark.end;
  });
  if (cursor < props.text.length) {
    pieces.push({ key: `t-${cursor}`, text: props.text.slice(cursor), mark: null });
  }

  return (
    <section className="notice-reader-card" data-testid={props.testId}>
      <div className="notice-reader-header">
        <h3 className="notice-reader-title">{props.title}</h3>
        <p className="notice-reader-legend">
          <span className="quote-mark">Quoted passage</span>
          <span className="pii-vault-span">Flagged locally (check manually)</span>
        </p>
      </div>
      <div className="notice-reader-body">
        {pieces.map((piece) =>
          piece.mark ? (
            <mark
              key={piece.key}
              className={piece.mark.kind === "quote" ? "quote-mark" : "pii-vault-span"}
              title={piece.mark.label}
            >
              {piece.text}
            </mark>
          ) : (
            <span key={piece.key}>{piece.text}</span>
          )
        )}
      </div>
    </section>
  );
}
