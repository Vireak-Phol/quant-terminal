import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import React from 'react'
import { useLiveOrderBook, __resetSharedSockets } from './useLiveOrderBook'

class MockWS {
  static instances: MockWS[] = []
  static OPEN = 1
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {
    MockWS.instances.push(this)
  }
  send(s: string) {
    this.sent.push(s)
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  // test helpers
  fireOpen() {
    this.readyState = 1
    this.onopen?.()
  }
  fireMessage(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
  fireDrop() {
    this.readyState = 3
    this.onclose?.()
  }
}

function Consumer({ id }: { id: string }) {
  const { data, connectionState } = useLiveOrderBook()
  return (
    <div data-testid={id}>
      {connectionState}:{data?.mid_price ?? 'none'}
    </div>
  )
}

describe('useLiveOrderBook shared socket', () => {
  beforeEach(() => {
    MockWS.instances = []
    __resetSharedSockets()
    vi.useFakeTimers()
    ;(globalThis as any).WebSocket = MockWS
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('opens exactly one socket for many consumers and fans out frames', () => {
    const { getByTestId } = render(
      <>
        <Consumer id="a" />
        <Consumer id="b" />
        <Consumer id="c" />
      </>,
    )
    expect(MockWS.instances.length).toBe(1)
    act(() => {
      MockWS.instances[0].fireOpen()
      MockWS.instances[0].fireMessage({ type: 'bookmap_update', mid_price: 4012.5, timestamp: Date.now() })
    })
    expect(getByTestId('a').textContent).toBe('connected:4012.5')
    expect(getByTestId('c').textContent).toBe('connected:4012.5')
  })

  it('ignores command replies so they do not wipe book state', () => {
    const { getByTestId } = render(<Consumer id="a" />)
    act(() => {
      MockWS.instances[0].fireOpen()
      MockWS.instances[0].fireMessage({ type: 'bookmap_update', mid_price: 1, timestamp: Date.now() })
      MockWS.instances[0].fireMessage({ type: 'recorder_status', status: 'stopped' })
    })
    expect(getByTestId('a').textContent).toBe('connected:1')
  })

  it('reconnects after a drop and closes when the last consumer unmounts', () => {
    const { unmount } = render(<Consumer id="a" />)
    act(() => MockWS.instances[0].fireOpen())
    act(() => MockWS.instances[0].fireDrop())
    expect(MockWS.instances.length).toBe(1)
    act(() => {
      vi.advanceTimersByTime(2100)
    })
    expect(MockWS.instances.length).toBe(2)
    unmount()
    expect(MockWS.instances[1].readyState).toBe(3)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(MockWS.instances.length).toBe(2)
  })
})
