import { canonicalize, domainOf, parseAddressList } from './addresses.ts'

/** Lowercased header names; values repeat where the header does. */
export type Headers = Record<string, string[]>

export type OwnerSource =
  | 'x-gm-original-to'
  | 'x-beenthere'
  | 'delivered-to'
  | 'to'
  | 'cc'
  | 'from'
  | 'shared-account'
  | 'confirmation'
  | 'manual'

export interface OwnerAssignment {
  alias: string
  source: OwnerSource
}

/**
 * Evidence ranked strongest to weakest.
 *
 * The first two name the envelope recipient, the only thing that survives a
 * BCC, and cover the two delivery paths: `x-gm-original-to` from Workspace
 * default routing, `x-beenthere` from a Group redistribution, where
 * `Delivered-To` names the shared account rather than the member.
 */
const SOURCE_PRIORITY: OwnerSource[] = [
  'manual',
  'confirmation',
  'shared-account',
  'x-gm-original-to',
  'x-beenthere',
  'delivered-to',
  'from',
  'to',
  'cc',
]

function rank(source: OwnerSource): number {
  const i = SOURCE_PRIORITY.indexOf(source)
  return i < 0 ? SOURCE_PRIORITY.length : i
}

export interface ResolveInput {
  headers: Headers
  /** Gmail label ids (INBOX, SENT, TRASH, ...). */
  labels: string[]
}

export interface ResolveContext {
  /** Every alias ever issued, canonicalized. Includes departed members. */
  knownAliases: Set<string>
  /** The shared mailbox itself. Never an owner in its own right. */
  sharedAccountEmail: string
  /** Operators, who receive what is addressed to the shared mailbox. */
  adminAliases?: string[]
  /** Aliases outside this domain are outside parties. */
  orgDomain: string
}

/**
 * The address out of an `X-BeenThere`, which Groups writes with a parameter
 * list appended: `support@example.com; h="ATskLdf..."`.
 */
const groupAddress = (value: string): string => value.split(';')[0]!.trim()

function headerValues(headers: Headers, name: string): string[] {
  return headers[name.toLowerCase()] ?? []
}

/** Sender of Gmail's send-as and forwarding confirmations. */
const CONFIRMATION_SENDER = 'forwarding-noreply@google.com'

function isSendAsConfirmation(headers: Headers): boolean {
  for (const raw of headerValues(headers, 'from')) {
    for (const addr of parseAddressList(raw)) {
      if (canonicalize(addr.email) === CONFIRMATION_SENDER) return true
    }
  }
  return false
}

/** Operator aliases, minus the shared account itself, which is never an owner. */
function operatorOwners(ctx: ResolveContext, source: OwnerSource): OwnerAssignment[] {
  const shared = canonicalize(ctx.sharedAccountEmail)
  return (ctx.adminAliases ?? [])
    .map((alias) => canonicalize(alias))
    .filter((alias) => alias !== shared)
    .map((alias) => ({ alias, source }))
}

/** Whether any recipient header names the shared mailbox. */
function addressedToSharedAccount(headers: Headers, ctx: ResolveContext): boolean {
  const shared = canonicalize(ctx.sharedAccountEmail)
  if (!shared.includes('@')) return false
  for (const name of ['x-gm-original-to', 'x-beenthere', 'delivered-to', 'to', 'cc']) {
    const prepare = name === 'x-beenthere' ? groupAddress : (v: string) => v
    for (const raw of headerValues(headers, name)) {
      for (const addr of parseAddressList(prepare(raw))) {
        if (canonicalize(addr.email) === shared) return true
      }
    }
  }
  return false
}

/**
 * Aliases a message belongs to. All matches, not the first: one message
 * addressed to two members is owned by both. Empty routes to unassigned.
 */
export function resolveOwners(
  input: ResolveInput,
  ctx: ResolveContext,
): OwnerAssignment[] {
  // Google's send-as confirmation carries a code an operator has to act on,
  // addressed to the member whose address is being set up. It is setup traffic,
  // not that member's mail, so it goes to the operators instead.
  if (isSendAsConfirmation(input.headers)) {
    const operators = operatorOwners(ctx, 'confirmation')
    if (operators.length > 0) return operators
  }

  const best = new Map<string, OwnerSource>()

  const consider = (email: string, source: OwnerSource): void => {
    const alias = canonicalize(email)
    if (!alias.includes('@')) return
    if (alias === canonicalize(ctx.sharedAccountEmail)) return
    if (domainOf(alias) !== ctx.orgDomain) return
    if (!ctx.knownAliases.has(alias)) return

    const current = best.get(alias)
    if (current === undefined || rank(source) < rank(current)) best.set(alias, source)
  }

  const considerHeader = (
    name: string, source: OwnerSource, prepare: (value: string) => string = (v) => v,
  ): void => {
    for (const raw of headerValues(input.headers, name)) {
      for (const addr of parseAddressList(prepare(raw))) consider(addr.email, source)
    }
  }

  // Envelope recipient first, by either delivery path.
  considerHeader('x-gm-original-to', 'x-gm-original-to')
  considerHeader('x-beenthere', 'x-beenthere', groupAddress)
  considerHeader('delivered-to', 'delivered-to')
  considerHeader('to', 'to')
  considerHeader('cc', 'cc')

  // Gated on SENT so a spoofed inbound From cannot assign ownership. Not an
  // else-branch: mail between members carries SENT and INBOX together.
  if (input.labels.includes('SENT') || input.labels.includes('DRAFT')) {
    considerHeader('from', 'from')
  }

  // Addressed to the shared mailbox itself, and claimed by nobody else: it
  // belongs to whoever administers the deployment.
  if (best.size === 0 && addressedToSharedAccount(input.headers, ctx)) {
    for (const owner of operatorOwners(ctx, 'shared-account')) {
      best.set(owner.alias, owner.source)
    }
  }

  return [...best.entries()]
    .map(([alias, source]) => ({ alias, source }))
    .sort((a, b) => rank(a.source) - rank(b.source) || a.alias.localeCompare(b.alias))
}
