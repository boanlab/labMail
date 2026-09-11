/**
 * Sample mail for evaluating the interface before Google is connected.
 *
 *   npm run seed:demo -- <address>      seed that member's mailbox
 *   npm run seed:demo -- --clear        remove seeded rows
 *
 * Refuses to run while Google is connected. Rows carry a `demo-` gmail_id, so
 * removal is exact.
 */
import { db } from '../db/index.ts'
import { isGoogleConnected } from '../core/settings.ts'

const PREFIX = 'demo-'
const args = process.argv.slice(2)

function clear(): void {
  const info = db.prepare(`DELETE FROM messages WHERE gmail_id LIKE '${PREFIX}%'`).run()
  console.log(`Removed ${info.changes} demo messages.`)
}

if (args.includes('--clear')) { clear(); process.exit(0) }

if (isGoogleConnected()) {
  console.error('Google is connected — refusing to mix demo mail into a real mailbox.')
  console.error('Disconnect first, or run with --clear to remove existing demo data.')
  process.exit(1)
}

const username = args[0]?.trim().toLowerCase()
if (!username) {
  console.error('Usage: npm run seed:demo -- <address>   |   npm run seed:demo -- --clear')
  process.exit(1)
}

// Either form: sign-in names are addresses, and older accounts keep a name.
const user = db.prepare(`
  SELECT alias_email, display_name FROM users
  WHERE lower(username) = ? OR lower(alias_email) = ?
`)
  .get(username, username) as
  | { alias_email: string | null; display_name: string }
  | undefined

if (!user?.alias_email) {
  console.error(`"${username}" has no mail address yet. Approve the account first.`)
  process.exit(1)
}

const me = user.alias_email
const ME = me
const ME_NAME = user.display_name
const HOUR = 3_600_000
const now = Date.now()

interface Seed {
  id: string; thread: string; subject: string; from: string; name: string
  body: string; labels: string[]; ago: number; attachment?: [string, string, number]
  /** Marks a draft so it opens in the composer. Editing it needs a real Gmail draft. */
  draft?: boolean
}

const SEEDS: Seed[] = [
  { id: '1', thread: 'a', subject: '실험 장비 예약 문의', from: 'park@other.ac.kr', name: '박서준',
    body: '안녕하세요.\n\n다음 주 화요일부터 목요일까지 3일간 측정 장비를 사용할 수 있을지 문의드립니다.\n일정이 가능하다면 예약 절차도 함께 알려주시면 감사하겠습니다.\n\n박서준 드림',
    labels: ['INBOX', 'UNREAD'], ago: 0.4 },
  { id: '2', thread: 'b', subject: '[공지] 정기 시스템 점검 안내', from: 'noreply@service.example',
    name: '서비스팀', body: '3월 15일 02:00–05:00 사이 정기 점검이 예정되어 있습니다.\n해당 시간 동안 일시적으로 접속이 제한될 수 있습니다.',
    labels: ['INBOX', 'UNREAD', 'STARRED'], ago: 5 },
  { id: '3', thread: 'c', subject: '논문 초고 검토 부탁드립니다', from: 'kim@other.ac.kr', name: '김민서',
    body: '초고를 첨부합니다.\n\n3장 실험 설계 부분을 중심으로 봐주시면 좋겠습니다.\n다음 주 금요일까지 의견 주시면 반영하겠습니다.\n\n감사합니다.',
    labels: ['INBOX'], ago: 27, attachment: ['draft-v3.pdf', 'application/pdf', 2_412_000] },
  { id: '4', thread: 'd', subject: '프로젝트 킥오프 일정', from: 'choi@other.ac.kr', name: '최지우',
    body: '킥오프 미팅을 언제 하면 좋을까요?\n이번 주나 다음 주 중으로 잡으면 좋겠습니다.', labels: ['INBOX'], ago: 52 },
  { id: '5', thread: 'd', subject: 'Re: 프로젝트 킥오프 일정', from: me, name: user.display_name,
    body: '다음 주 화요일 오후 2시는 어떠신가요?\n회의실은 제가 예약해 두겠습니다.', labels: ['SENT'], ago: 50 },
  { id: '6', thread: 'd', subject: 'Re: 프로젝트 킥오프 일정', from: 'choi@other.ac.kr', name: '최지우',
    body: '화요일 2시 좋습니다. 그때 뵙겠습니다.\n\n> 다음 주 화요일 오후 2시는 어떠신가요?\n> 회의실은 제가 예약해 두겠습니다.',
    labels: ['INBOX', 'UNREAD'], ago: 48 },
  { id: '7', thread: 'e', subject: '예산 집행 내역 송부', from: 'yoon@other.ac.kr', name: '윤하늘',
    body: '요청하신 지난 분기 집행 내역입니다.\n확인 후 회신 부탁드립니다.', labels: ['INBOX'], ago: 96,
    attachment: ['budget-q1.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 184_320] },
  { id: '8', thread: 'f', subject: '학회 발표 자료 공유', from: 'lee@other.ac.kr', name: '이도현',
    body: '지난주 학회에서 발표한 자료를 공유드립니다.\n관심 있으실 것 같아 보내드려요.', labels: ['INBOX'], ago: 170 },
  { id: '9', thread: 'g', subject: '회신: 공동연구 협의', from: me, name: user.display_name,
    body: '말씀하신 방향으로 진행하면 좋겠습니다.\n초안을 이번 주 내로 정리해서 보내드리겠습니다.', labels: ['SENT'], ago: 200 },
  { id: '10', thread: 'h', subject: '오래된 안내 메일', from: 'archive@other.ac.kr', name: '보관함',
    body: '보관함에서 확인할 수 있는 메일입니다.', labels: [], ago: 900 },
  { id: '11', thread: 'i', subject: '광고성 메일', from: 'promo@other.example', name: '프로모션',
    body: '휴지통에서 확인할 수 있는 메일입니다.', labels: ['TRASH'], ago: 40 },
  { id: '12', thread: 'j', subject: '[광고] 특별 할인 안내', from: 'sale@promo.example', name: '프로모션',
    body: '스팸함에서 확인할 수 있는 메일입니다.', labels: ['SPAM'], ago: 18 },
  { id: '13', thread: 'k', subject: '학술대회 초청', from: 'chair@conf.example', name: '학술대회 사무국',
    body: '초청장을 보내드립니다. 정상 메일이지만 스팸으로 분류된 예시입니다.',
    labels: ['SPAM', 'UNREAD'], ago: 30 },
  { id: '14', thread: 'l', subject: '실험 결과 정리 중', from: ME, name: ME_NAME,
    body: '작성 중인 메일입니다. 임시보관함에서 이어서 쓸 수 있습니다.', labels: ['DRAFT'], ago: 2,
    draft: true },
]

const insertMessage = db.prepare(`
  INSERT INTO messages (gmail_id, gmail_thread_id, gmail_draft_id, rfc822_id, from_addr, from_name,
                        to_addrs, cc_addrs, subject, snippet, body_text, labels, internal_date,
                        has_attachments)
  VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)
  ON CONFLICT (gmail_id) DO NOTHING
`)
const insertOwner = db.prepare(`
  INSERT INTO message_owners (message_id, alias, source) VALUES (?, ?, 'manual')
  ON CONFLICT (message_id, alias) DO NOTHING
`)
const insertAttachment = db.prepare(`
  INSERT INTO attachments (message_id, gmail_att_id, filename, mime_type, size_bytes)
  VALUES (?, ?, ?, ?, ?)
`)

const seeded = db.transaction(() => {
  let n = 0
  for (const s of SEEDS) {
    const info = insertMessage.run(
      `${PREFIX}${s.id}`, `${PREFIX}t${s.thread}`,
      s.draft ? `${PREFIX}draft-${s.id}` : null,
      `<${PREFIX}${s.id}@example.invalid>`,
      s.from, s.name, JSON.stringify([me]), s.subject,
      s.body.split('\n').filter(Boolean)[0]?.slice(0, 110) ?? '',
      s.body, JSON.stringify(s.labels), now - s.ago * HOUR, s.attachment ? 1 : 0,
    )
    if (info.changes === 0) continue
    insertOwner.run(info.lastInsertRowid, me)
    if (s.attachment) {
      insertAttachment.run(info.lastInsertRowid, `${PREFIX}att${s.id}`, ...s.attachment)
    }
    n++
  }
  return n
})()

console.log(`Seeded ${seeded} demo messages for ${me}.`)
console.log('Remove them later with: npm run seed:demo -- --clear')
