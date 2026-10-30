import { useCallback, useEffect, useRef, useState } from 'react'

/** Minimal typing for the (still prefixed in some browsers) Web Speech API. */
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  start(): void
  abort(): void
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}

type Ctor = new () => SpeechRecognitionLike

function recognitionCtor(): Ctor | null {
  const w = window as unknown as { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && recognitionCtor() !== null
}

const ERROR_TEXT: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked. Allow it in your browser settings to use voice.',
  'service-not-allowed': 'Voice recognition is not allowed in this browser.',
  'no-speech': "I didn't hear anything. Try again.",
  network: 'Voice recognition needs a network connection in this browser.',
  'audio-capture': 'No microphone was found.',
}

/**
 * Speech-to-text using the browser's recogniser. Audio is never sent to the LifeOS server, but some
 * browsers (e.g. Chrome) process it with their vendor's cloud service — see README "Privacy".
 */
export function useSpeech(onTranscript: (text: string) => void) {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<SpeechRecognitionLike | null>(null)
  const callback = useRef(onTranscript)

  useEffect(() => {
    callback.current = onTranscript
  }, [onTranscript])
  useEffect(() => () => rec.current?.abort(), [])

  const start = useCallback(() => {
    const Recognition = recognitionCtor()
    if (!Recognition) {
      setError('Voice input is not supported in this browser.')
      return
    }
    setError(null)
    const r = new Recognition()
    r.lang = document.documentElement.lang || navigator.language || 'en-US'
    r.interimResults = false
    r.maxAlternatives = 1
    r.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript?.trim()
      if (text) callback.current(text)
    }
    r.onerror = (e) => setError(ERROR_TEXT[e.error] ?? 'Voice recognition failed. Please try again.')
    r.onend = () => setListening(false)
    rec.current = r
    setListening(true)
    r.start()
  }, [])

  const stop = useCallback(() => {
    rec.current?.abort()
    setListening(false)
  }, [])

  return { listening, error, start, stop, supported: speechSupported() }
}
