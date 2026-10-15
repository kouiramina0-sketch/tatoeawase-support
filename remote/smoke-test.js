(() => {
  const config = window.TATOEAWASE_FIREBASE_CONFIG || {};
  const runButton = document.getElementById('run');
  const stepsEl = document.getElementById('steps');
  const logEl = document.getElementById('log');

  const sessions = [];
  let roomId = null;
  let roomCode = null;

  function appendStep(label, ok, detail='') {
    const row = document.createElement('div');
    row.className = 'step';
    row.innerHTML =
      '<span class="' + (ok ? 'ok' : 'bad') + '">' +
      (ok ? 'PASS' : 'FAIL') + '</span> ' +
      escapeHtml(label) +
      (detail ? '<div class="muted">' + escapeHtml(detail) + '</div>' : '');
    stepsEl.appendChild(row);
  }

  function log(value) {
    logEl.textContent = value;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
  }

  async function authAnonymous() {
    const response = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' +
        encodeURIComponent(config.apiKey),
      {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({returnSecureToken:true}),
      }
    );
    if (!response.ok) {
      throw new Error('Anonymous Auth ' + response.status + ': ' + (await response.text()).slice(0,120));
    }
    const p = await response.json();
    const session = {uid:p.localId,idToken:p.idToken};
    sessions.push(session);
    return session;
  }

  function pathUrl(session, path) {
    const clean = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return config.databaseUrl.replace(/\/+$/,'') + '/' + clean + '.json?auth=' +
      encodeURIComponent(session.idToken);
  }

  async function db(session, path, method='GET', body) {
    const response = await fetch(pathUrl(session,path), {
      method,
      headers:body === undefined ? undefined : {'Content-Type':'application/json'},
      body:body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      const err = new Error(method + ' ' + path + ' -> ' + response.status + ' ' + text.slice(0,180));
      err.status = response.status;
      throw err;
    }
    return !text || text === 'null' ? null : JSON.parse(text);
  }

  function makeCode() {
    const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out='';
    for(let i=0;i<6;i++) out += alphabet[Math.floor(Math.random()*alphabet.length)];
    return out;
  }

  async function cleanup(host) {
    if (!host || !roomId || !roomCode) return;
    try {
      await db(host,'','PATCH',{
        ['roomCodes/' + roomCode]:null,
        ['rooms/' + roomId]:null,
      });
    } catch {}
  }

  runButton.onclick = async () => {
    runButton.disabled = true;
    stepsEl.innerHTML = '';
    log('実行中…');
    let host = null;

    try {
      if (!config.apiKey || !config.databaseUrl) throw new Error('Firebase config missing');

      host = await authAnonymous();
      const guest1 = await authAnonymous();
      const guest2 = await authAnonymous();
      appendStep('匿名認証を3セッション作成', true);

      roomCode = makeCode();
      roomId = host.uid.slice(0,12) + '-smoke-' + Date.now().toString(36);
      const now = Date.now();
      const meta = {
        id:roomId, code:roomCode, hostId:host.uid, status:'lobby', locked:false,
        createdAt:now, expiresAt:now + 4*60*60*1000,
      };

      await db(host,'','PATCH',{
        ['roomCodes/' + roomCode]:roomId,
        ['rooms/' + roomId + '/meta']:meta,
      });
      appendStep('ホストがルーム作成', true, roomCode);

      const roomFound = await db(guest1,'roomCodes/' + roomCode);
      if (roomFound !== roomId) throw new Error('roomCodes lookup mismatch');
      appendStep('ゲストがルームコードから検索', true);

      const participants = [
        [host,'SmokeHost'],
        [guest1,'SmokeGuest1'],
        [guest2,'SmokeGuest2'],
      ];
      for (let i=0;i<participants.length;i++) {
        const [s,name] = participants[i];
        await db(s,'rooms/' + roomId + '/members/' + s.uid,'PUT',{
          id:s.uid,name,joinedAt:now+i,connected:true,
        });
      }
      const memberMap = await db(host,'rooms/' + roomId + '/members');
      if (!memberMap || Object.keys(memberMap).length !== 3) {
        throw new Error('member count != 3');
      }
      appendStep('ホスト＋ゲスト2人が参加', true);

      await db(host,'rooms/' + roomId + '/meta/locked','PUT',true);
      const locked = await db(guest1,'rooms/' + roomId + '/meta/locked');
      if (locked !== true) throw new Error('lock not visible');
      appendStep('ホストがルームをロック', true);

      let lateJoinDenied = false;
      const late = await authAnonymous();
      try {
        await db(late,'rooms/' + roomId + '/members/' + late.uid,'PUT',{
          id:late.uid,name:'Late',joinedAt:Date.now(),connected:true,
        });
      } catch (e) {
        lateJoinDenied = e.status === 401 || e.status === 403;
      }
      if (!lateJoinDenied) throw new Error('late join was unexpectedly allowed');
      appendStep('ロック後の第三者参加を拒否', true);

      const round = {
        roundNumber:1,
        topicId:'smoke_topic',
        title:'Remote Smoke Test',
        choices:[
          {index:0,label:'A'},
          {index:1,label:'B'},
          {index:2,label:'C'},
        ],
        answerDeadlineAt:null,
      };
      await db(host,'','PATCH',{
        ['rooms/' + roomId + '/meta/status']:'answering',
        ['rooms/' + roomId + '/round']:round,
        ['rooms/' + roomId + '/answers']:null,
      });
      appendStep('第1問を公開', true);

      const choiceBySession = [[host,0],[guest1,1],[guest2,2]];
      for (const [s,choiceIndex] of choiceBySession) {
        await db(s,'rooms/' + roomId + '/answers/' + s.uid,'PUT',{
          choiceIndex,roundNumber:1,submittedAt:Date.now(),
        });
      }
      appendStep('3人が秘密回答を送信', true);

      const allAnswers = await db(host,'rooms/' + roomId + '/answers');
      if (!allAnswers || Object.keys(allAnswers).length !== 3) {
        throw new Error('host cannot read 3 answers');
      }
      appendStep('ホストだけが全回答を取得', true);

      const own = await db(guest1,'rooms/' + roomId + '/answers/' + guest1.uid);
      if (!own || own.choiceIndex !== 1) throw new Error('guest cannot read own answer');

      let aggregateDenied = false;
      try {
        await db(guest1,'rooms/' + roomId + '/answers');
      } catch (e) {
        aggregateDenied = e.status === 401 || e.status === 403;
      }
      if (!aggregateDenied) throw new Error('guest could read aggregate answers');
      appendStep('ゲストは自分の回答だけ読める', true);

      await cleanup(host);
      const gone = await db(host,'roomCodes/' + roomCode);
      if (gone !== null) throw new Error('room code cleanup failed');
      appendStep('ルームとコードを削除', true);

      log('ALL PASS\nFirebase実通信とSecurity Rulesの基本経路は正常です。');
    } catch (e) {
      appendStep('テスト停止', false, e?.message || String(e));
      log('FAIL\n' + (e?.stack || e?.message || String(e)));
      await cleanup(host);
    } finally {
      runButton.disabled = false;
    }
  };
})();