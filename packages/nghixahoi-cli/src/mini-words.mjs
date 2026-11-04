// Every word the Mini shows, in one place: the client's Vietnamese, word for word as the deck has it (slide 1 of the second
// deck, docs/plans/2026-10-28-vietnamese-mini-dashboard-claims.md, CHANGE LIST), and drafts in the deck's voice where the deck
// does not reach (the plan's Q2: the operator approves them in one batch). Each line says which: "deck" or "draft". A "\n" is a
// line break the Mini draws; "{N}" is the cycle's number, which the page fills in. Everything here is NFC, and every character
// is in the fonts the Mini embeds (test/mini-words.test.mjs). Nothing here may say a reward was claimed, saved or confirmed
// (hard rule 8), and nothing speaks of a voucher's code: "code" here is the code a person writes ("cày code"). Since 2026-11-03 the
// button's call to action at 100 % alone names the reward, `claim` and `claimTitle`, as the dashboard's own claim button does: what
// the person may do, never what was done.
//
// The Mini shows its label, its counters' names and its button in capitals, as the English was (its stylesheet); the words
// are kept here as the deck writes them. The deck's IDLE is "remove": the Mini has no idle counter since 2026-10-28.
//
// The prompt hook says none of these: its words are English, byte for byte (hard rule 7; src/tracker-problems.mjs).

export const MINI_WORDS = {
  // The page's own name, which the OS lists the window by (draft).
  title: 'Kit=Code – Tổ code ghi công',

  // The title bar (src/companion-controls.mjs): its tooltip, Welcome's approved X7e; the red dot's tooltip and its name (drafts).
  chrome: {
    drag: 'Kéo để di chuyển cửa sổ',
    hide: 'Ẩn',
    hideName: 'Ẩn cửa sổ Kit=Code',
  },

  // The label on the left, on its two lines: the deck's in cycle 1 (slide 1, "TỔ CODE / GHI CÔNG"); from cycle 2 on, the
  // cycle's number (draft); once the campaign has ended, whatever the cycle (draft). The first line is the same in all three.
  brand: {
    counter: 'TỔ CODE\nGHI CÔNG',
    cycle: 'TỔ CODE\nVÒNG {N}',
    ended: 'TỔ CODE\nKHÉP SỔ',
  },

  // The label's name, as assistive technology reads it, in each of the three (drafts).
  brandName: {
    counter: 'Tổ code ghi công',
    cycle: 'Tổ code ghi công, vòng {N}',
    ended: 'Tổ code khép sổ: chương trình đã kết thúc',
  },

  // The counters: the group's name (draft), the = typed and the focus time (the deck, slide 1).
  counters: 'Bộ đếm của Kit=Code',
  equals: 'Số dấu =',
  worked: 'Thời gian cày code',

  // The button, which opens the dashboard (the deck, slide 1), and its tooltip (draft).
  seeMore: 'Xem thêm',
  seeMoreTitle: 'Mở dashboard để xem lời nhắn của từng mốc nghỉ đã đạt',

  // Since 2026-11-03 (companion/2-claim-ready; the client's feedback of that day): the same button while the cycle's 100 % is reached
  // and the campaign has not ended, when the dashboard offers the claim: the client's words, as the dashboard's claim button says them
  // ("Nhận thưởng"), and its tooltip (draft). It opens the dashboard as ever, which says whether today's vouchers are open.
  claim: 'Nhận Thưởng',
  claimTitle: 'Mở dashboard để nhận voucher của mốc 100%',

  // Since 2026-10-30: the line in the title bar while a newer Kit=Code is out, the operator's of 2026-10-29 ("Có bản mới <version> · mở
  // <dashboard host>"), "{V}" its version and "{HOST}" the dashboard's address, which the page fills in, shown in capitals as the label
  // is; and its tooltip (draft). It opens the dashboard, as the button does.
  update: 'Có bản mới {V} · mở {HOST}',
  updateTitle: 'Mở dashboard để cập nhật Kit=Code',
};
