/** Lightweight, accessible SVG charts (no charting dependency). Each chart has a text table fallback. */

interface Series {
  label: string
  values: number[]
  className: string
}

export function GroupedBars({ labels, series, title, height = 160 }: { labels: string[]; series: Series[]; title: string; height?: number }) {
  const max = Math.max(1, ...series.flatMap((s) => s.values))
  const width = Math.max(labels.length * 18, 300)
  const groupW = width / labels.length
  const barW = Math.max(2, (groupW - 4) / series.length)
  return (
    <figure>
      <svg viewBox={`0 0 ${width} ${height + 18}`} className="h-auto w-full" role="img" aria-label={title} preserveAspectRatio="none">
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={0} x2={width} y1={height - f * height} y2={height - f * height} className="stroke-border" strokeWidth={0.5} />
        ))}
        {labels.map((label, i) =>
          series.map((s, j) => {
            const v = s.values[i] ?? 0
            const h = (v / max) * (height - 4)
            return (
              <rect key={`${label}-${s.label}`} x={i * groupW + 2 + j * barW} y={height - h} width={barW - 1} height={h} rx={1} className={s.className}>
                <title>{`${label}: ${v} ${s.label.toLowerCase()}`}</title>
              </rect>
            )
          }),
        )}
        {labels.map((label, i) =>
          labels.length <= 14 || i % Math.ceil(labels.length / 10) === 0 ? (
            <text key={label} x={i * groupW + groupW / 2} y={height + 13} textAnchor="middle" className="fill-ink-3 text-[9px]">
              {label}
            </text>
          ) : null,
        )}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-4 text-xs text-ink-3">
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <svg className="size-2.5" aria-hidden>
              <rect width="10" height="10" rx="2" className={s.className} />
            </svg>
            {s.label}
          </span>
        ))}
      </figcaption>
      {/* Tables ignore width:1px, so the visually hidden wrapper is a div (prevents horizontal overflow). */}
      <div className="sr-only">
      <table>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>Label</th>
            {series.map((s) => (
              <th key={s.label}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((l, i) => (
            <tr key={l}>
              <td>{l}</td>
              {series.map((s) => (
                <td key={s.label}>{s.values[i] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </figure>
  )
}

export function HBars({ rows, title }: { rows: { label: string; value: number; secondary?: number }[]; title: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value + (r.secondary ?? 0)))
  return (
    <ul aria-label={title} className="space-y-2">
      {rows.map((r) => (
        <li key={r.label} className="text-sm">
          <div className="mb-0.5 flex justify-between gap-2">
            <span className="truncate">{r.label}</span>
            <span className="shrink-0 text-ink-3">
              {r.value}
              {r.secondary !== undefined ? ` done · ${r.secondary} open` : ''}
            </span>
          </div>
          <div className="flex h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <div className="bg-accent" style={{ width: `${(r.value / max) * 100}%` }} />
            {r.secondary !== undefined ? <div className="bg-warn/60" style={{ width: `${(r.secondary / max) * 100}%` }} /> : null}
          </div>
        </li>
      ))}
    </ul>
  )
}
