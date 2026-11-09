// UI text and agent log messages. Job names and program output are never translated.
export const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'ko', label: '한국어' },
  { code: 'ja', label: '日本語' },
];

export const I18N = {
  ko: {
    agentRunning: '에이전트 실행 중', agentOffline: '에이전트에 연결할 수 없음', settings: '설정',
    title: '시작 작업', subtitle: '스위치를 켠 작업은 PC를 켤 때 자동으로 실행돼요.', add: '작업 추가',
    empty: '아직 등록된 작업이 없어요.', emptyAdd: '첫 작업 추가하기',
    run: '실행', rerun: '다시 실행', stop: '중지', more: (n) => `${n} 더보기`, edit: '수정', del: '삭제',
    toggleLabel: (n) => `${n}: 부팅 시 자동 실행`, back: '작업 목록',
    recentLog: '최근 로그', noLog: '아직 기록이 없어요.', deleteThis: '이 작업 삭제',
    addTitle: '작업 추가', editTitle: '작업 수정',
    fName: '이름', fNamePh: '예: 로컬 ComfyUI', fCmd: '실행할 명령', fCmdPh: '예: node server.js',
    adv: '고급 설정', fCwd: '작업 폴더', fCwdPh: '비워 두면 사용자 홈 폴더', fDelay: '시작 지연 (초)', fRestart: '꺼지면',
    r0: '그대로 두기', r3: '3번까지 다시 켜기', rAlways: '항상 다시 켜기', fHidden: '콘솔 창 숨기고 실행',
    cancel: '취소', save: '저장', errRequired: '이름과 실행할 명령을 적어 주세요.', errGeneric: '저장하지 못했어요. 다시 시도해 주세요.',
    delQ: (n) => `‘${n}’ 작업을 삭제할까요?`,
    st: { running: '실행 중', done: '완료', failed: '실패', stopped: '중지됨', waiting: '대기 중' },
    kCmd: '명령', kCwd: '작업 폴더', kDelay: '시작 지연', delayV: (n) => `${n}초 뒤`, kRestart: '꺼지면', kWindow: '콘솔 창', windowShown: '보이게 실행',
    language: '표시 언어', autoStart: 'PC를 켤 때 b_jobs 시작', autoStartDesc: '끄면 어떤 작업도 자동으로 실행되지 않아요.',
    autoStartUnsupported: '이 OS에서는 아직 지원하지 않아요.', errAutostart: '자동 시작 설정을 바꾸지 못했어요.',
    log: {
      started: (pid) => `시작함 (PID ${pid})`, manual: (pid) => `수동으로 시작함 (PID ${pid})`, restarted: (pid) => `다시 시작함 (PID ${pid})`,
      stopped: '중지함', ok: '정상 종료', err: (c) => `오류로 종료 (코드 ${c})`,
      restartIn: (s, n, max) => `${s}초 뒤 다시 시작 (${max ? `${n}/${max}` : `${n}번째`})`,
      waitDelay: (s) => `${s}초 뒤 시작 예정`, adopted: (pid) => `실행 중인 프로세스를 이어서 관리 (PID ${pid})`,
      gone: '프로세스가 종료됨', spawnError: (m) => `실행하지 못함: ${m}`, cwdMissing: (p) => `작업 폴더가 없음: ${p}`,
    },
  },
  en: {
    agentRunning: 'Agent running', agentOffline: 'Can’t reach the agent', settings: 'Settings',
    title: 'Startup jobs', subtitle: 'Jobs with the switch on start automatically when your PC starts.', add: 'Add job',
    empty: 'No jobs yet.', emptyAdd: 'Add your first job',
    run: 'Run', rerun: 'Run again', stop: 'Stop', more: (n) => `More options for ${n}`, edit: 'Edit', del: 'Delete',
    toggleLabel: (n) => `${n}: run at startup`, back: 'Jobs',
    recentLog: 'Recent log', noLog: 'Nothing logged yet.', deleteThis: 'Delete this job',
    addTitle: 'Add job', editTitle: 'Edit job',
    fName: 'Name', fNamePh: 'e.g. Local ComfyUI', fCmd: 'Command to run', fCmdPh: 'e.g. node server.js',
    adv: 'Advanced', fCwd: 'Working folder', fCwdPh: 'Blank = your home folder', fDelay: 'Start delay (sec)', fRestart: 'If it exits',
    r0: 'Leave it', r3: 'Restart up to 3 times', rAlways: 'Always restart', fHidden: 'Hide the console window',
    cancel: 'Cancel', save: 'Save', errRequired: 'Enter a name and a command.', errGeneric: 'Couldn’t save. Please try again.',
    delQ: (n) => `Delete “${n}”?`,
    st: { running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped', waiting: 'Waiting' },
    kCmd: 'Command', kCwd: 'Working folder', kDelay: 'Start delay', delayV: (n) => `${n} sec`, kRestart: 'If it exits', kWindow: 'Console window', windowShown: 'Shown',
    language: 'Display language', autoStart: 'Start b_jobs with your PC', autoStartDesc: 'When off, no job runs automatically.',
    autoStartUnsupported: 'Not supported on this OS yet.', errAutostart: 'Couldn’t change the startup setting.',
    log: {
      started: (pid) => `Started (PID ${pid})`, manual: (pid) => `Started manually (PID ${pid})`, restarted: (pid) => `Restarted (PID ${pid})`,
      stopped: 'Stopped', ok: 'Exited normally', err: (c) => `Exited with error (code ${c})`,
      restartIn: (s, n, max) => `Restarting in ${s} sec (${max ? `${n}/${max}` : `#${n}`})`,
      waitDelay: (s) => `Starting in ${s} sec`, adopted: (pid) => `Took over the running process (PID ${pid})`,
      gone: 'Process ended', spawnError: (m) => `Couldn’t start: ${m}`, cwdMissing: (p) => `Working folder not found: ${p}`,
    },
  },
  ja: {
    agentRunning: 'エージェント実行中', agentOffline: 'エージェントに接続できません', settings: '設定',
    title: '起動ジョブ', subtitle: 'スイッチをオンにしたジョブは、PCの起動時に自動で実行されます。', add: 'ジョブを追加',
    empty: 'まだジョブがありません。', emptyAdd: '最初のジョブを追加',
    run: '実行', rerun: '再実行', stop: '停止', more: (n) => `${n}のその他の操作`, edit: '編集', del: '削除',
    toggleLabel: (n) => `${n}: 起動時に自動実行`, back: 'ジョブ一覧',
    recentLog: '最近のログ', noLog: 'まだ記録がありません。', deleteThis: 'このジョブを削除',
    addTitle: 'ジョブを追加', editTitle: 'ジョブを編集',
    fName: '名前', fNamePh: '例: ローカル ComfyUI', fCmd: '実行するコマンド', fCmdPh: '例: node server.js',
    adv: '詳細設定', fCwd: '作業フォルダー', fCwdPh: '空欄ならホームフォルダー', fDelay: '起動の遅延（秒）', fRestart: '終了したら',
    r0: 'そのままにする', r3: '3回まで再起動', rAlways: '常に再起動', fHidden: 'コンソールウィンドウを隠す',
    cancel: 'キャンセル', save: '保存', errRequired: '名前と実行するコマンドを入力してください。', errGeneric: '保存できませんでした。もう一度お試しください。',
    delQ: (n) => `「${n}」を削除しますか？`,
    st: { running: '実行中', done: '完了', failed: '失敗', stopped: '停止済み', waiting: '待機中' },
    kCmd: 'コマンド', kCwd: '作業フォルダー', kDelay: '起動の遅延', delayV: (n) => `${n}秒後`, kRestart: '終了したら', kWindow: 'コンソールウィンドウ', windowShown: '表示する',
    language: '表示言語', autoStart: 'PCの起動時にb_jobsを開始', autoStartDesc: 'オフにすると、どのジョブも自動では実行されません。',
    autoStartUnsupported: 'このOSではまだ対応していません。', errAutostart: '自動起動の設定を変更できませんでした。',
    log: {
      started: (pid) => `開始しました (PID ${pid})`, manual: (pid) => `手動で開始しました (PID ${pid})`, restarted: (pid) => `再起動しました (PID ${pid})`,
      stopped: '停止しました', ok: '正常に終了しました', err: (c) => `エラーで終了しました（コード ${c}）`,
      restartIn: (s, n, max) => `${s}秒後に再起動します（${max ? `${n}/${max}` : `${n}回目`}）`,
      waitDelay: (s) => `${s}秒後に開始します`, adopted: (pid) => `実行中のプロセスを引き継ぎました (PID ${pid})`,
      gone: 'プロセスが終了しました', spawnError: (m) => `開始できませんでした: ${m}`, cwdMissing: (p) => `作業フォルダーが見つかりません: ${p}`,
    },
  },
};

export function detectLang() {
  for (const l of navigator.languages || [navigator.language || 'en']) {
    const code = String(l).slice(0, 2).toLowerCase();
    if (I18N[code]) return code;
  }
  return 'en';
}
