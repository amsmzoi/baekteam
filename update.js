/* "오늘자 업데이트" 버튼
   GitHub Actions의 "주가 업데이트" 작업을 실행하고, 끝나면 페이지를 새로 고친다.
   토큰은 이 브라우저(localStorage)에만 저장한다. 사이트 파일에는 절대 넣지 않는다. */
(function () {
  "use strict";

  // 사이트 주소(아이디.github.io/저장소)에서 저장소를 알아낸다. 내 컴퓨터에서 열면 기본값.
  var OWNER = "amsmzoi", REPO = "baekteam";
  if (/\.github\.io$/.test(location.hostname)) {
    OWNER = location.hostname.split(".")[0];
    REPO = location.pathname.split("/")[1] || REPO;
  }
  var WF = "update.yml", KEY = "baekteam_gh_token";
  var API = "https://api.github.com/repos/" + OWNER + "/" + REPO + "/actions";
  var RUN_PAGE = "https://github.com/" + OWNER + "/" + REPO + "/actions/workflows/" + WF;

  var $ = function (id) { return document.getElementById(id); };
  var btn = $("updBtn"), dlg = $("updDlg"), status = $("updStatus");
  $("runLink").href = RUN_PAGE;

  function getTok() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function setTok(t) { try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch (e) {} }
  function say(html, err) { status.hidden = false; status.innerHTML = html; status.classList.toggle("err", !!err); }
  function gh(path, tok, opt) {
    opt = opt || {};
    return fetch(API + path, {
      method: opt.method || "GET",
      headers: { "Authorization": "Bearer " + tok, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      body: opt.body ? JSON.stringify(opt.body) : undefined,
      cache: "no-store"
    });
  }
  function openDlg() {
    $("tokIn").value = "";
    $("tokForget").hidden = !getTok();
    if (dlg.showModal) dlg.showModal(); else window.open(RUN_PAGE, "_blank");
  }

  function start(tok) {
    btn.disabled = true;
    var t0 = Date.now() - 60000;
    say("업데이트를 요청하는 중…");
    gh("/workflows/" + WF + "/dispatches", tok, { method: "POST", body: { ref: "main" } }).then(function (r) {
      if (r.status === 401 || r.status === 403 || r.status === 404) {
        setTok(null); btn.disabled = false;
        say("토큰이 맞지 않거나 권한이 부족해요. 버튼을 다시 눌러 토큰을 새로 넣어 주세요. (오류 " + r.status + ")", true);
        return;
      }
      if (r.status !== 204) throw new Error("오류 " + r.status);
      say("업데이트 시작했어요. 보통 2~4분 걸려요. 이 화면을 열어 두면 끝나고 자동으로 새로 고쳐요.");
      poll(tok, t0, 0);
    }).catch(function (e) {
      btn.disabled = false;
      say("요청하지 못했어요 (" + e.message + "). <a href=\"" + RUN_PAGE + "\" target=\"_blank\" rel=\"noopener\">GitHub에서 직접 실행</a>해 주세요.", true);
    });
  }

  function poll(tok, t0, n) {
    if (n > 60) { btn.disabled = false; say("15분이 지나도 끝나지 않았어요. <a href=\"" + RUN_PAGE + "\" target=\"_blank\" rel=\"noopener\">GitHub에서 상태 보기</a>", true); return; }
    setTimeout(function () {
      gh("/workflows/" + WF + "/runs?event=workflow_dispatch&per_page=1", tok).then(function (r) { return r.json(); }).then(function (d) {
        var run = (d.workflow_runs || [])[0];
        if (!run || new Date(run.created_at).getTime() < t0) { poll(tok, t0, n + 1); return; }
        if (run.status !== "completed") {
          say("업데이트 중이에요… (" + (run.status === "queued" ? "차례 기다리는 중" : "주가 받는 중") + ", " + Math.round((Date.now() - t0 - 60000) / 1000) + "초 지남)");
          poll(tok, t0, n + 1); return;
        }
        if (run.conclusion === "success") {
          say("업데이트 끝! 사이트에 반영되는 데 몇십 초 걸려서, 잠시 뒤 새로 고칠게요.");
          setTimeout(function () { location.reload(); }, 30000);
        } else {
          btn.disabled = false;
          say("업데이트가 실패했어요. <a href=\"" + run.html_url + "\" target=\"_blank\" rel=\"noopener\">무엇이 잘못됐는지 보기</a>", true);
        }
      }).catch(function () { poll(tok, t0, n + 1); });
    }, 15000);
  }

  btn.addEventListener("click", function () {
    var tok = getTok();
    if (tok) start(tok); else openDlg();
  });
  $("tokSave").addEventListener("click", function () {
    var t = $("tokIn").value.trim();
    if (!t) { $("tokIn").focus(); return; }
    setTok(t); dlg.close(); start(t);
  });
  $("tokClear").addEventListener("click", function (e) {
    e.preventDefault(); setTok(null); $("tokForget").hidden = true; say("이 기기에 저장된 토큰을 지웠어요.");
  });
  // 길게 누르거나 오른쪽 클릭하면 토큰 창을 연다 (토큰 바꾸기·지우기용)
  btn.addEventListener("contextmenu", function (e) { e.preventDefault(); openDlg(); });
})();
