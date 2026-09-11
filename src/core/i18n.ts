import type { IncomingMessage } from 'node:http'

export const LOCALES = ['ko', 'en'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'ko'
export const LOCALE_COOKIE = 'labmail_lang'

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value)

/** Server-side user-facing messages. Keys are shared with the client catalog. */
export const CATALOG = {
  ko: {
    'drive.notFound': '파일을 찾을 수 없습니다.',
    'drive.nameInvalid': '사용할 수 없는 이름입니다.',
    'drive.noFolder': '이 계정에는 아직 Drive 폴더가 없습니다.\n관리자에게 문의하세요.',
    'drive.tooLarge':
      '파일이 너무 큽니다.\n최대 100MB까지 올릴 수 있습니다.',
    'mailbox.undoExpired': '이미 발송되어 취소할 수 없습니다.',
    'mailbox.draftNotFound': '임시보관 메일을 찾을 수 없습니다.',
    'mailbox.invalidAddress': "'{address}' 은(는) 올바른 이메일 주소가 아닙니다.",
    'error.notSignedIn': '로그인이 필요합니다.',
    'error.adminOnly': '관리자만 사용할 수 있습니다.',
    'error.notFound': '요청한 경로를 찾을 수 없습니다.',
    'error.methodNotAllowed': '허용되지 않은 메서드입니다.',
    'error.badJson': '요청 본문이 올바른 JSON이 아닙니다.',
    'error.tooLarge': '요청이 너무 큽니다.',
    'error.internal': '서버 오류가 발생했습니다.',

    'auth.badCredentials': '주소 또는 비밀번호가 올바르지 않습니다.',
    'auth.throttled':
      '로그인 시도가 너무 많습니다.\n{seconds}초 뒤에 다시 시도하세요.',
    'auth.pending': '아직 관리자 승인 대기 중입니다.',
    'auth.deactivated': '비활성화된 계정입니다.',
    'auth.signupReceived': '가입 신청이 접수되었습니다.\n관리자 승인 후 로그인할 수 있습니다.',

    'signup.passwordLength': '비밀번호는 10자 이상이어야 합니다.',
    'signup.displayNameRequired': '이름을 입력하세요.',
    'signup.taken': '이미 사용 중인 주소입니다.',
    'signup.unknownDomain':
      '요청한 도메인을 쓸 수 없습니다.\n관리자에게 문의하세요.',
    'signup.sharedAccount':
      '공용 계정과 같은 주소는 쓸 수 없습니다.\n그 주소로는 메일을 받을 수 없습니다.',
    'signup.passwordMismatch': '새 비밀번호가 서로 일치하지 않습니다.',

    'password.wrongCurrent': '현재 비밀번호가 올바르지 않습니다.',
    'password.unchanged': '새 비밀번호가 현재 비밀번호와 같습니다.',
    'password.changed':
      '비밀번호를 변경했습니다.\n다른 기기의 로그인은 모두 해제됩니다.',

    'address.format': '주소는 3~32자의 영문, 숫자, 점, 밑줄, 하이픈만 사용할 수 있습니다.',
    'address.consecutiveDots': '주소에 점을 연속으로 쓸 수 없습니다.',
    'address.taken': '이미 사용 중인 주소입니다.',

    'mailbox.noAddress': '이 계정에는 메일 주소가 없습니다.\n관리자 › 시스템 설정에서 주소를 지정하세요.',
    'appPassword.noLabel':
      '이 비밀번호를 쓸 기기 이름을 적어주세요.',
    'appPassword.tooMany':
      '앱 비밀번호가 너무 많습니다.\n쓰지 않는 것을 먼저 폐기하세요.',
    'mailbox.sendNotReady': '이 주소로는 메일을 보낼 수 없습니다.\n관리자가 발신 설정을 마치면 사용할 수 있습니다.',
    'mailbox.unknown': '알 수 없는 메일함입니다.',
    'mailbox.unknownFilter': '알 수 없는 필터입니다.',
    'mailbox.messageNotFound': '메일을 찾을 수 없습니다.',
    'mailbox.noRecipient': '받는 사람을 입력하세요.',
    'mailbox.noSelection': '선택된 메일이 없습니다.',

    'rule.nameRequired': '규칙 이름을 입력하세요.',
    'rule.needCondition': '조건을 하나 이상 추가하세요.',
    'rule.tooManyConditions': '조건은 최대 10개까지 지정할 수 있습니다.',
    'rule.badField': '지원하지 않는 조건 항목입니다.',
    'rule.badOperator': '지원하지 않는 조건 연산자입니다.',
    'rule.needValue': '조건 값을 입력하세요.',
    'rule.needAction': '동작을 하나 이상 선택하세요.',
    'rule.tooMany': '규칙은 최대 100개까지 만들 수 있습니다.',
    'rule.notFound': '규칙을 찾을 수 없습니다.',
    'category.nameRequired': '카테고리 이름을 입력하세요.',
    'category.duplicate': '같은 이름의 카테고리가 이미 있습니다.',
    'category.notFound': '카테고리를 찾을 수 없습니다.',
    'category.tooMany': '카테고리는 최대 50개까지 만들 수 있습니다.',
    'category.badColor': '지원하지 않는 색상입니다.',
    'member.adminProtected':
      '관리자 계정은 비활성화할 수 없습니다.\n먼저 다른 계정에 관리자 권한을 넘기세요.',
    'member.notFound': '해당 계정을 찾을 수 없습니다.',
    'member.alreadyApproved': '이미 승인된 계정입니다.',
    'member.noRequestedAddress': '신청한 주소가 없는 계정입니다.',
    'member.noPending': '승인 대기 중인 계정이 아닙니다.',
    'member.aliasTaken': '{alias} 는 이미 사용 중입니다.',
    'member.provisionFailed': '주소 생성에 실패했습니다: {reason}. 원인을 해결한 뒤 다시 승인하세요.',

    'setup.noDomain':

      '조직 도메인이 설정되지 않았습니다.\n시스템 설정을 먼저 완료하세요.',
    'setup.notConnected':
      'Google 연동이 완료되지 않아 주소를 만들 수 없습니다.\n시스템 설정에서 연결하세요.',
    'setup.syncUnavailable': 'Google 연동이 설정되지 않았습니다.',
    'setup.missingSetting': 'Google 연동이 아직 설정되지 않았습니다 ({key}). 관리자 › 시스템 설정에서 입력하세요.',

    'oauth.noClient': '먼저 클라이언트 ID와 시크릿을 저장하세요.',
    'oauth.stateExpired':
      '인증 상태가 만료되었습니다.\n다시 시도하세요.',
    'oauth.noCode': '인증 코드가 없습니다.',
    'oauth.denied': 'Google 인증이 거부되었습니다: {reason}',
    'oauth.noRefreshToken':
      'refresh token을 받지 못했습니다.\nhttps://myaccount.google.com/permissions 에서 기존 권한을 취소한 뒤 다시 연결하세요.',

    'sendAs.unavailable':
      '{alias} 승인 완료. 수신은 바로 됩니다.\n'
      + '발신은 공용 계정 설정에 이 주소를 추가해야 열립니다.\n'
      + '추가하면 1분 안에 자동으로 반영됩니다.',
  },
  en: {
    'drive.notFound': 'File not found.',
    'drive.nameInvalid': 'That name cannot be used.',
    'drive.noFolder': 'This account has no Drive folder yet.\nAsk an administrator.',
    'drive.tooLarge':
      'File is too large.\nThe limit is 100MB.',
    'mailbox.undoExpired': 'Already sent; it can no longer be recalled.',
    'mailbox.draftNotFound': 'Draft not found.',
    'mailbox.invalidAddress': "'{address}' is not a valid email address.",
    'error.notSignedIn': 'Sign in required.',
    'error.adminOnly': 'Administrators only.',
    'error.notFound': 'Not found.',
    'error.methodNotAllowed': 'Method not allowed.',
    'error.badJson': 'Request body is not valid JSON.',
    'error.tooLarge': 'Request too large.',
    'error.internal': 'Internal server error.',

    'auth.badCredentials': 'Incorrect address or password.',
    'auth.throttled':
      'Too many sign-in attempts.\nTry again in {seconds} seconds.',
    'auth.pending': 'This account is still awaiting administrator approval.',
    'auth.deactivated': 'This account has been deactivated.',
    'auth.signupReceived': 'Your request was received.\nYou can sign in once an administrator approves it.',

    'signup.passwordLength': 'Password must be at least 10 characters.',
    'signup.displayNameRequired': 'Display name is required.',
    'signup.taken': 'That address is already taken.',
    'signup.unknownDomain':
      'That domain is not available.\nAsk an operator.',
    'signup.sharedAccount': 'The shared account address cannot be reused — mail sent to it is never attributed to anyone.',
    'signup.passwordMismatch': 'The two new passwords do not match.',

    'password.wrongCurrent': 'Current password is incorrect.',
    'password.unchanged': 'The new password is the same as the current one.',
    'password.changed':
      'Password changed.\nEvery other signed-in device has been signed out.',

    'address.format': 'Address must be 3–32 characters: letters, digits, dot, underscore, hyphen.',
    'address.consecutiveDots': 'Address cannot contain consecutive dots.',
    'address.taken': 'That address is already in use.',

    'mailbox.noAddress': 'This account has no mail address.\nAssign one under Admin › System settings.',
    'appPassword.noLabel':
      'Name the device this password is for.',
    'appPassword.tooMany':
      'Too many app passwords.\nRevoke one you no longer use first.',
    'mailbox.sendNotReady': 'This address cannot send mail yet.\nIt becomes available once an operator finishes the sending setup.',
    'mailbox.unknown': 'Unknown mailbox.',
    'mailbox.unknownFilter': 'Unknown filter.',
    'mailbox.messageNotFound': 'Message not found.',
    'mailbox.noRecipient': 'Enter at least one recipient.',
    'mailbox.noSelection': 'No messages selected.',

    'rule.nameRequired': 'Enter a rule name.',
    'rule.needCondition': 'Add at least one condition.',
    'rule.tooManyConditions': 'At most 10 conditions per rule.',
    'rule.badField': 'Unsupported condition field.',
    'rule.badOperator': 'Unsupported condition operator.',
    'rule.needValue': 'Enter a value for the condition.',
    'rule.needAction': 'Choose at least one action.',
    'rule.tooMany': 'At most 100 rules per member.',
    'rule.notFound': 'No such rule.',
    'category.nameRequired': 'Enter a category name.',
    'category.duplicate': 'A category with that name already exists.',
    'category.notFound': 'No such category.',
    'category.tooMany': 'At most 50 categories per member.',
    'category.badColor': 'Unsupported colour.',
    'member.adminProtected':
      'An administrator account cannot be deactivated.\nHand the admin role to another account first.',
    'member.notFound': 'No such account.',
    'member.alreadyApproved': 'Already approved.',
    'member.noRequestedAddress': 'This account has no requested address.',
    'member.noPending': 'No pending account with that id.',
    'member.aliasTaken': '{alias} is already in use.',
    'member.provisionFailed':
      'Provisioning failed: {reason}.\nFix the cause and approve again.',

    'setup.noDomain':

      'The organization domain is not configured.\nComplete system settings first.',
    'setup.notConnected':
      'Google is not connected, so the address cannot be created.\nConnect it in system settings.',
    'setup.syncUnavailable': 'Google is not connected.',
    'setup.missingSetting':
      'Google is not configured yet ({key}).\nEnter it under Admin › System settings.',

    'oauth.noClient': 'Save the client ID and secret first.',
    'oauth.stateExpired':
      'The authorization request expired.\nTry again.',
    'oauth.noCode': 'No authorization code was returned.',
    'oauth.denied': 'Google authorization was denied: {reason}',
    'oauth.noRefreshToken':
      'Google did not return a refresh token.\nRevoke the existing grant at https://myaccount.google.com/permissions and connect again.',

    'sendAs.unavailable':
      'Approved: {alias}.\n'
      + 'Mail arrives right away.\n'
      + 'Sending opens once this address is added under the shared account\'s settings.\n'
      + 'It takes effect within a minute.',
  },
} as const

export type MessageKey = keyof (typeof CATALOG)['en']

/** Translate a key, substituting `{name}` placeholders. */
export function t(
  locale: Locale,
  key: MessageKey,
  params: Record<string, string | number> = {},
): string {
  const template = CATALOG[locale]?.[key] ?? CATALOG[DEFAULT_LOCALE][key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params[name] ?? `{${name}}`))
}

function parseAcceptLanguage(header: string | undefined): Locale | null {
  if (!header) return null
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...rest] = part.trim().split(';')
      const q = rest.find((r) => r.trim().startsWith('q='))
      return { tag: (tag ?? '').toLowerCase(), q: q ? Number(q.split('=')[1]) : 1 }
    })
    .sort((a, b) => b.q - a.q)
  for (const { tag } of ranked) {
    const base = tag.split('-')[0]
    if (isLocale(base)) return base
  }
  return null
}

/** Explicit cookie first, then Accept-Language, then the default. */
export function resolveLocale(req: IncomingMessage): Locale {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === LOCALE_COOKIE) {
      const value = decodeURIComponent(rest.join('='))
      if (isLocale(value)) return value
    }
  }
  return parseAcceptLanguage(req.headers['accept-language'] as string | undefined)
    ?? DEFAULT_LOCALE
}
