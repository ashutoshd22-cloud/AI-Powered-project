import { useEffect } from 'react'
import { useBackdropPrefs } from '../app/backdrop'
import { MOOD_COLORS, MOOD_LABEL, type Mood } from '../lib/mood'

/**
 * Decorative background layer: either ambient light whose colour follows the user's tasks, or a
 * background scene. It never receives pointer events and is hidden from assistive technology;
 * the current mood is announced as text elsewhere when it matters (overdue banners etc.).
 */
export function Backdrop({ mood }: { mood: Mood }) {
  const [{ backdrop, intensity }] = useBackdropPrefs()

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('has-backdrop', backdrop !== 'minimal')
    return () => root.classList.remove('has-backdrop')
  }, [backdrop])

  if (backdrop === 'minimal') return null
  const [a, b, c] = MOOD_COLORS[mood]

  if (backdrop === 'ambient') {
    return (
      <div
        aria-hidden
        data-mood={mood}
        data-mood-label={MOOD_LABEL[mood]}
        className={`ambient pointer-events-none fixed inset-0 -z-10 overflow-hidden ${intensity === 'vivid' ? 'ambient-vivid' : ''}`}
        style={{ '--glow-a': a, '--glow-b': b, '--glow-c': c } as React.CSSProperties}
      >
        <span className="ambient-blob ambient-blob-a" />
        <span className="ambient-blob ambient-blob-b" />
        <span className="ambient-blob ambient-blob-c" />
      </div>
    )
  }

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" data-scene={backdrop}>
      <img src={`/scenes/${backdrop}.svg`} alt="" className="scene-image h-full w-full object-cover" decoding="async" />
      {/* Readability veil: keeps text contrast acceptable over any part of the picture. */}
      <div className={`scene-veil absolute inset-0 ${intensity === 'vivid' ? 'scene-veil-vivid' : ''}`} />
      {/* A hint of the task mood on top of the scene. */}
      <div
        className="ambient-tint absolute inset-0"
        style={{ '--glow-a': a } as React.CSSProperties}
      />
    </div>
  )
}
