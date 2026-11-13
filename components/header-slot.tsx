"use client"

import { useSyncExternalStore } from "react"
import { createPortal } from "react-dom"

// The site header has a free area between its menu button and the theme and
// user buttons. A page puts something there by wrapping it in <InHeader>; it
// is drawn in the header while the page is open and gone when the page is.

export const HEADER_SLOT_ID = "app-header-slot"

const nothing = () => () => {}

export function InHeader({ children }: { children: React.ReactNode }) {
  // The header is rendered by the layout; the page finds its slot once it is in the document (null on the server and on first paint).
  const slot = useSyncExternalStore(nothing, () => document.getElementById(HEADER_SLOT_ID), () => null)
  return slot ? createPortal(children, slot) : null
}
