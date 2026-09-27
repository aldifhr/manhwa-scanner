'use client'

import { IconMinus } from '@tabler/icons-react'
import * as React from 'react'
import { OTPInput, OTPInputContext, REGEXP_ONLY_DIGITS } from 'input-otp'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

import { cn } from '@/lib/utils'

type Sweep = { id: number; from: number; to: number; tone: 'paste' | 'success' }

type InputOTPStatus = { invalid: boolean; success: boolean; sweep: Sweep | null }

const InputOTPStatusContext = React.createContext<InputOTPStatus>({
  invalid: false,
  success: false,
  sweep: null,
})

const SWEEP_TIMING = {
  paste: { duration: 0.4, stagger: 0.045 },
  success: { duration: 0.42, stagger: 0.048 },
} as const

const RING_TRAVEL = 0.42

type RingBox = { x: number; y: number; width: number; height: number }

function InputOTP({
  className,
  containerClassName,
  'aria-invalid': ariaInvalid,
  value,
  onChange,
  success = false,
  maxLength,
  children,
  ...props
}: Omit<React.ComponentProps<typeof OTPInput>, 'render' | 'children'> & {

  children?: React.ReactNode
  containerClassName?: string

  success?: boolean
}) {
  const invalid = ariaInvalid === true || ariaInvalid === 'true'
  const reduceMotion = useReducedMotion()
  const [sweep, setSweep] = React.useState<Sweep | null>(null)
  const filled = React.useRef(0)
  const sweepId = React.useRef(0)

  const startSweep = (from: number, to: number, tone: Sweep['tone']) => {
    sweepId.current += 1
    setSweep({ id: sweepId.current, from, to, tone })
  }

  const handleChange = (next: string) => {
    const from = filled.current
    filled.current = next.length

    if (!reduceMotion && next.length - from > 1) startSweep(from, next.length, 'paste')

    onChange?.(next)
  }

  React.useEffect(() => {
    if (typeof value === 'string') filled.current = value.length
  }, [value])

  React.useEffect(() => {
    if (!success || reduceMotion) return

    sweepId.current += 1
    setSweep({ id: sweepId.current, from: 0, to: maxLength, tone: 'success' })
  }, [success, maxLength, reduceMotion])

  React.useEffect(() => {
    if (!sweep) return

    const { duration, stagger } = SWEEP_TIMING[sweep.tone]
    const span = duration + stagger * (sweep.to - sweep.from)
    const timer = window.setTimeout(() => setSweep(null), span * 1000)

    return () => window.clearTimeout(timer)
  }, [sweep])

  return (
    <InputOTPStatusContext.Provider value={{ invalid, success, sweep }}>
      <OTPInput
        data-slot="input-otp"

        data-success={success || undefined}
        aria-invalid={ariaInvalid}
        value={value}
        onChange={handleChange}
        maxLength={maxLength}
        containerClassName={cn(

          'cn-input-otp flex max-w-full items-center gap-3 [--otp-radius:var(--radius-xl)] has-disabled:opacity-50 max-sm:[--otp-radius:var(--radius-lg)]',
          containerClassName,
        )}
        spellCheck={false}
        className={cn('disabled:cursor-not-allowed', className)}
        {...props}
        inputMode="numeric"
        pattern={REGEXP_ONLY_DIGITS}
      >
        {children}

        <InputOTPRing />
      </OTPInput>
    </InputOTPStatusContext.Provider>
  )
}

function InputOTPRing() {
  const context = React.useContext(OTPInputContext)
  const { invalid, sweep } = React.useContext(InputOTPStatusContext)
  const reduceMotion = useReducedMotion()
  const ref = React.useRef<HTMLSpanElement>(null)
  const [box, setBox] = React.useState<RingBox | null>(null)

  const wasShown = React.useRef(false)

  const slots = context?.slots ?? []
  let first = -1
  let last = -1
  for (const [index, slot] of slots.entries()) {
    if (!slot.isActive) continue
    if (first === -1) first = index
    last = index
  }
  const complete = slots.length > 0 && slots.every((slot) => Boolean(slot.char))

  const shown = first !== -1 && (!complete || last > first)

  const measure = React.useCallback(() => {
    const container = ref.current?.closest('[data-input-otp-container]')
    const from = container?.querySelector(
      `[data-slot="input-otp-slot"][data-index="${String(first)}"]`,
    )
    const to = container?.querySelector(
      `[data-slot="input-otp-slot"][data-index="${String(last)}"]`,
    )
    if (!container || !from || !to) return
    const row = container.getBoundingClientRect()
    const head = from.getBoundingClientRect()
    const tail = to.getBoundingClientRect()
    setBox({
      x: head.left - row.left,
      y: head.top - row.top,
      width: tail.right - head.left,
      height: head.height,
    })
  }, [first, last])

  React.useLayoutEffect(() => {
    if (!shown) return
    measure()
    const container = ref.current?.closest('[data-input-otp-container]')
    if (!container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [shown, measure])

  const jump = !wasShown.current
  React.useEffect(() => {
    wasShown.current = shown && box !== null
  })

  const spring = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, duration: sweep ? RING_TRAVEL : 0.3, bounce: 0.18 }
  const move = jump ? { duration: 0 } : spring

  return (
    <motion.span
      ref={ref}
      data-slot="input-otp-ring"
      aria-hidden
      initial={false}
      animate={{
        x: box?.x ?? 0,
        y: box?.y ?? 0,
        width: box?.width ?? 0,
        height: box?.height ?? 0,
        opacity: shown && box ? 1 : 0,
      }}
      transition={{
        x: move,
        y: move,
        width: move,
        height: move,
        opacity: reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
      }}
      className={cn(
        'pointer-events-none absolute top-0 left-0 z-20 rounded-(--otp-radius) ring-[3px]',
        invalid ? 'ring-destructive' : 'ring-foreground/75',
      )}
    />
  )
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="input-otp-group"

      className={cn('flex min-w-0 items-center gap-3', className)}
      {...props}
    />
  )
}

function InputOTPSlot({
  index,
  className,
  style,
  ...props
}: React.ComponentProps<'div'> & {
  index: number
}) {
  const inputOTPContext = React.useContext(OTPInputContext)
  const { invalid, success, sweep } = React.useContext(InputOTPStatusContext)
  const { char, isActive } = inputOTPContext?.slots[index] ?? {}
  const swept = sweep !== null && index >= sweep.from && index < sweep.to
  const isComplete = inputOTPContext?.slots.every((slot) => Boolean(slot.char)) ?? false
  const reduceMotion = useReducedMotion()

  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}

      data-index={index}

      className={cn(
        '[container-type:inline-size] relative flex aspect-square min-h-12 w-14 min-w-0 items-center justify-center rounded-(--otp-radius) bg-foreground/[0.06] text-2xl font-semibold tabular-nums ring-1 ring-foreground/8 transition-[background-color,color] duration-150 ease-out outline-none *:text-[min(1.5rem,43cqi)] data-[active=true]:z-10 data-[active=true]:bg-foreground/10 motion-reduce:transition-none',
        swept && sweep?.tone === 'success' && 'otp-bounce',
        className,
      )}

      style={
        { ...style, '--otp-trail-index': sweep ? index - sweep.from : 0 } as React.CSSProperties
      }
      {...props}
    >
      {swept && sweep ? (
        <span

          key={`${sweep.id}-${index}`}
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 rounded-(--otp-radius)',
            sweep.tone === 'success' ? 'otp-trail-success' : 'otp-trail',
          )}
        />
      ) : null}
      <span
        className={cn(
          'relative grid place-items-center [perspective:240px]',
          isComplete && !success && 'otp-processing',
        )}
        style={{ '--otp-wave-index': index } as React.CSSProperties}
      >
        <span
          aria-hidden
          className={cn(
            'col-start-1 row-start-1 text-foreground/20 transition-opacity duration-150 ease-out motion-reduce:transition-none',
            char ? 'opacity-0' : 'opacity-100',
          )}
        >
          0
        </span>
        <AnimatePresence initial={false}>
          {char ? (
            <motion.span
              key={`${index}-${char}`}
              initial={
                reduceMotion
                  ? false
                  : {
                      opacity: 0,
                      transform: 'translateY(6px) rotateX(-35deg)',
                      filter: 'blur(2px)',
                    }
              }
              animate={{
                opacity: 1,
                transform: 'translateY(0px) rotateX(0deg)',
                filter: 'blur(0px)',
              }}
              exit={
                reduceMotion
                  ? { opacity: 0 }
                  : {
                      opacity: 0,
                      transform: 'translateY(-2px) rotateX(15deg)',
                      filter: 'blur(2px)',
                    }
              }
              transition={
                reduceMotion ? { duration: 0 } : { type: 'spring', duration: 0.3, bounce: 0.2 }
              }
              style={{ transformOrigin: 'center bottom', transformStyle: 'preserve-3d' }}
              className="col-start-1 row-start-1 text-foreground"
            >
              {char}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </span>
    </div>
  )
}

function InputOTPSeparator({ ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="input-otp-separator"
      className="flex shrink-0 items-center text-muted-foreground [&_svg:not([class*='size-'])]:size-5"
      role="separator"
      {...props}
    >
      <IconMinus />
    </div>
  )
}

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator }
