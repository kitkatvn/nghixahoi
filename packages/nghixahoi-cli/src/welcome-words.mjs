// Every word Welcome shows, in one place: the client's Vietnamese, word for word as the deck has it, and the operator's
// approved drafts where the deck does not reach (docs/plans/2026-10-22-vietnamese-setup-and-welcome-strings.md; each line
// names its row there, a number for the deck's, an id for a draft's). "just make sure the translation stay truthful to the
// deck": the deck's own spelling stays, "Kit=Code" in row 56 included. A "\n" is the deck's line break; "{N}" is a count and
// "{name}" a folder's name, which the page fills in. Everything here is NFC, and every character is in the fonts Welcome
// embeds (test/welcome-words.test.mjs). Nothing here may say a reward was claimed, saved or confirmed (hard rule 8): "Đã lưu
// project" is about projects.
//
// The page shows some of these in capitals, as the English was: the rail, the + THÊM PROJECT button (typed so by
// onboarding-window.mjs), and the section titles and the hint (by its stylesheet).

export const WELCOME_WORDS = {
  // The page's own name, which the OS lists the window by (X8a), and the native window's, before the page loads (X8b).
  title: 'Thiết lập Kit=Code',
  windowTitle: 'Chào mừng bạn đến với Kit=Code',

  // The title bar (src/onboarding-platform.mjs): its tooltip (X7e), and the close dot's tooltip and name (X7g, X7f).
  chrome: {
    drag: 'Kéo để di chuyển cửa sổ',
    close: 'Đóng',
    closeName: 'Đóng cửa sổ thiết lập',
  },

  // The rail's steps 01 and 02 (rows 54, 55).
  rail: {
    tracking: 'Thiết lập',
    projects: 'Chọn project',
  },

  // Step 01: the question (row 56), its radio group's name (X7c, row 56 again), and the answers (rows 57, 58), between "[ ]".
  tracking: {
    question: 'Bắt đầu tracking sau khi thiết lập Kit=Code',
    groupName: 'Bắt đầu tracking sau khi thiết lập Kit=Code',
    yes: 'CÓ',
    no: 'KHÔNG',
  },

  // Step 02: the heading (row 59), the list's name (X7d), the button after "+ " (row 60), the hint beside it (row 61), the
  // empty list (X4), and each project's remove button, its tooltip (X7a) and its name (X7b).
  projects: {
    heading: 'Chọn một hoặc nhiều folder local',
    listName: 'Danh sách project của Kit=Code',
    add: 'Thêm project',
    hint: 'Các tệp hiện có sẽ được lấy làm mốc để theo dõi thay đổi.\nMã nguồn và mọi thay đổi đều chỉ được lưu trên máy bạn.',
    empty: 'Chưa thêm project nào',
    removeTitle: 'Gỡ project',
    removeName: 'Gỡ {name}',
  },

  // The main button: between "+ " and " ->" (row 62); while saving (N18); saved (row 72); after a failed save (X5a).
  buttons: {
    save: 'ĐÃ XONG, MỞ KIT=CODE ĐỂ TÍNH CÔNG',
    saving: 'Đang lưu…',
    saved: 'Thiết lập hoàn tất.',
    retry: 'Thử lưu lại',
  },

  // The message line, after "/* ".
  messages: {
    ready: 'Chọn một hay nhiều project để tiếp tục', // row 77
    suggested: 'Đã thêm {N} folder project. Kiểm tra và lưu để tiếp tục.', // row 64
    loaded: 'Đã chọn {N} project', // row 70
    stateFailed: 'Không thể tải trạng thái thiết lập trên máy. Hãy khởi động lại quá trình thiết lập và thử lại nhé!', // row 76
    noBridge: 'Không thể kết nối với Kit=Code setup. Vui lòng đóng cửa sổ này và thử lại.', // row 73
    picking: 'Đang mở trình chọn folder…', // N14
    pickCanceled: 'Đã hủy chọn project', // row 65
    readyToAdd: '{N} project đã sẵn sàng', // row 69
    alreadyAdded: 'Project đã được thêm', // row 63
    pickerFailed: 'Không thể mở trình chọn folder.\nHãy khởi động lại phần thiết lập và thử lại nhé!', // row 66
    removed: 'Đã gỡ project', // row 67
    removedFromSetup: 'Đã gỡ project khỏi phần thiết lập này.', // N15
    removeFailed: 'Không thể gỡ project.', // N16a
    removeFailedRetry: 'Không thể gỡ project. Hãy thử lại nhé!', // N16b
    noProjects: 'Hãy chọn ít nhất một project', // row 68
    saving: 'Đang lưu project và tùy chỉnh…', // row 75
    saveFailed: 'Không thể lưu thiết lập.', // N17
    requestFailed: 'Không thể gửi yêu cầu thiết lập. Yên tâm, lựa chọn của bạn vẫn còn đây.', // X5b
    saved: 'Vậy là xong. Kit=Code sắp lên sóng!', // row 71
  },
};

// A tester build's alone (src/diagnostics.mjs): the rail's step 03 (N19), the step's heading (row 78), what the build sends
// and never holds (row 79, two paragraphs), and the invited email's label (row 80). Any other build's page holds none of it.
export const WELCOME_TESTER_WORDS = {
  rail: 'Tìm sự cố',
  heading: 'TÌM SỰ CỐ ĐỂ KHÔNG SAI SỐ',
  text: 'Kit=Code gửi diagnostic log đến máy chủ, ghi lại các hoạt động và lỗi của Kit=Code (như lỗi khởi động tracker hoặc lỗi hook). Nhờ vậy, đội ngũ phát triển có thể truy vết sự cố mà không cần hỏi thêm bạn.\n\nDiagnostic log không chứa mã nguồn, tệp, prompt hay tên project của bạn.',
  emailLabel: 'Email nhận lời mời (không bắt buộc): Giúp đội ngũ hỗ trợ tìm đúng diagnostic log của bạn nhanh hơn.',
};

// What the main process answers (src/onboarding-electron.mjs), which the page shows on its message line as it is.
export const WELCOME_ERRORS = {
  invalidRequest: 'Yêu cầu thiết lập không hợp lệ.', // X6a, answered only to a sender other than Welcome's page
  noProjects: 'Hãy chọn ít nhất một project', // X6c, row 68's
  registerFailed: 'Kit=Code không thể thêm một trong các folder bạn vừa chọn.', // X6d
  trackerFailed: 'Đã lưu project, nhưng tracker không khởi động được', // row 74
  projectNotFound: 'Không tìm thấy project.', // X6e
  removeFailed: 'Kit=Code không thể gỡ project này.', // X6f
};

// A tester build's alone: an invited email that is not an address (X6b).
export const WELCOME_TESTER_ERRORS = {
  invalidEmail: 'Email này có vẻ chưa đúng. Kiểm tra lại hoặc để trống nhé.',
};

// What the deck keeps English ("ko cần dịch", rows 81-83), and what is never shown (N13): marked lang="en" in the page.
// The status bar's codes (setup:ready, projects:removed…) are codes, and stay where the script sets them (K7).
export const WELCOME_ENGLISH = {
  topTag: 'local-first setup', // row 81
  mode: 'NORMAL', // row 82
  shortcuts: '↑↓ move # space select # enter continue', // row 82
  pending: 'PENDING', // row 83
  tracked: 'TRACKED', // row 83
  added: '{N} ADDED', // N13, display: none
};
