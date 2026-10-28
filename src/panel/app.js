'use strict';
(() => {
    const $ = id => document.getElementById(id);
    let key = '', view = 'overview', refreshing = false, refreshQueued = false, status = null, modeDirty = false, pending = null, mutating = false;
    const actionLabels = {ban:'Бан',unban:'Разбан',timeout:'Таймаут',warn:'Предупреждение',delete:'Удаление',warning:'Сообщение'};
    const statusLabels = {confirmed:'Подтверждено',rejected:'Отказ Twitch',unknown:'Неизвестно',pending:'Ожидание',local:'Локально',failed:'Не выполнено',local_error:'Локальная ошибка'};
    const rules = {link:'Ссылка',forbidden_word:'Запрещённое слово',caps:'Капс',spam:'Повторы'};
    const sources = {chat:'Чат',api:'API / панель',automod:'Автомодерация',system:'Система'};
    const views = {
        overview:['Обзор','Твой чат.\nТвои правила.','Состояние бота, решения фильтров и последние действия.'],
        actions:['Журнал действий','Ничего не теряется.','Кто вызвал команду, кого она касается и что ответил Twitch.'],
        observations:['Наблюдение','Сначала проверяем.','Исходные сообщения и предполагаемые действия фильтров.'],
        moderation:['Модерация','Решение за вами.','Ручные команды выполняются даже в режиме наблюдения.']
    };
    function node(tag, text, className) {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        if (className) element.className = className;
        return element;
    }
    function notify(message, error = false) { $('notice').textContent = message; $('notice').className = `notice${error ? ' error' : ''}`; $('notice').hidden = false; }
    function logout() {
        key = ''; status = null; pending = null; modeDirty = false;
        $('app').hidden = true; $('login').hidden = false; $('api-key').value = '';
        $('confirm-dialog').close(); $('details-dialog').close();
        $('actions-table').replaceChildren(); $('observations-table').replaceChildren(); $('recent-actions').replaceChildren();
    }
    async function api(path, options = {}) {
        let response;
        try {response = await fetch(path,{...options,cache:'no-store',signal:AbortSignal.timeout(30000),
            headers:{'x-api-key':key,...(options.body ? {'Content-Type':'application/json'} : {})}});}
        catch {throw new Error(options.method === 'POST' ? 'Ответ сервера не получен. Проверьте журнал и зрителя перед повтором.' : 'Нет связи с локальным сервером бота.');}
        const data = await response.json();
        if (response.status === 401) {logout();throw new Error('Неверный API-ключ. Войдите снова.');}
        if (!response.ok) {
            const explanation = data.confirmation === 'unknown' ? 'Результат Twitch неизвестен. Проверьте зрителя перед повтором.' :
                data.confirmation === 'confirmed' ? 'Twitch подтвердил действие, но возникла локальная ошибка.' : data.error || 'Запрос не выполнен.';
            throw new Error(explanation + (data.auditId ? ` Журнал #${data.auditId}.` : ''));
        }
        return data;
    }
    function post(path, data) {return api(path,{method:'POST',body:JSON.stringify(data)});}
    function badge(value) {
        const className = value === 'confirmed' ? 'ok' : ['unknown','pending'].includes(value) ? 'warn' : ['rejected','failed','local_error'].includes(value) ? 'bad' : 'purple';
        return node('span',statusLabels[value] || value,`badge ${className}`);
    }
    const time = value => new Date(value).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
    const date = value => new Date(value).toLocaleDateString('ru-RU',{day:'2-digit',month:'short'});
    function details(title, row) { $('details-title').textContent = title; $('details-content').textContent = JSON.stringify({...row,created_at:new Date(row.created_at).toISOString()},null,2); $('details-dialog').showModal(); }
    function detailButton(title, row) {const button=node('button','Детали →','text-button');button.type='button';button.addEventListener('click',()=>details(title,row));return button;}
    function emptyTable(body, columns, message) {
        const cell=node('td',message,'empty');cell.colSpan=columns;
        const tr=node('tr');tr.append(cell);body.append(tr);
    }
    function renderActions(rows) {
        const table=$('actions-table');table.replaceChildren();
        if (!rows.length) emptyTable(table,5,'По этому фильтру записей пока нет.');
        for (const row of rows) {
            const tr=node('tr'),when=node('td',time(row.created_at));when.append(node('small',date(row.created_at)));
            const actor=node('td',row.actor);actor.append(node('small',sources[row.source] || row.source));
            const action=node('td',`${actionLabels[row.action] || row.action} · @${row.target}`);action.append(node('small',row.reason));
            const result=node('td');result.append(badge(row.status));if(row.http_status)result.append(node('small',`HTTP ${row.http_status}`));
            const last=node('td');last.append(detailButton(`Действие #${row.id}`,row));
            tr.append(when,actor,action,result,last);table.append(tr);
        }
        const recent=$('recent-actions');recent.replaceChildren();
        if (!rows.length) {const empty=node('div',undefined,'empty');empty.append(node('strong','Здесь появится история'),node('p','Действия бота и модераторов будут записываться автоматически.'));recent.append(empty);}
        for (const row of rows.slice(0,5)) {
            const item=node('div',undefined,'activity-row');
            const description=node('div');description.append(node('strong',`${actionLabels[row.action] || row.action} · @${row.target}`),node('p',`${row.actor} · ${row.reason || 'Без причины'}`));
            const result=node('div');result.append(badge(row.status),node('time',`${date(row.created_at)}, ${time(row.created_at)}`));
            item.append(node('span',row.action === 'unban' ? '↗' : '◇','activity-icon'),description,result);recent.append(item);
        }
    }
    function renderObservations(rows) {
        const table=$('observations-table');table.replaceChildren();
        if (!rows.length) emptyTable(table,5,'Решений по этому фильтру пока нет.');
        for (const row of rows) {
            const tr=node('tr'),when=node('td',time(row.created_at));when.append(node('small',date(row.created_at)));
            const user=node('td',`@${row.username}`);user.append(node('small',row.mode === 'observe' ? 'Наблюдение' : 'Активный режим'));
            const last=node('td');last.append(detailButton(`Решение #${row.id}`,row));
            tr.append(when,user,node('td',rules[row.rule] || row.rule),node('td',row.message,'message-cell'),last);table.append(tr);
        }
    }
    function renderStatus(data) {
        status=data;
        $('mode-heading').textContent=data.mode === 'active' ? 'Модерация активна.' : 'Сначала наблюдаем.';
        $('connection').textContent=data.connected ? '● Бот подключён' : '○ Нет связи с Twitch';
        $('connection').className=`badge ${data.connected ? 'ok' : 'warn'}`;
        $('stat-actions').textContent=data.summary.actions;
        $('stat-observed').textContent=data.summary.observations;
        $('stat-uncertain').textContent=data.summary.uncertain;
        $('channel').textContent=data.channel ? `#${data.channel}` : 'Не настроен';
        $('bot-name').textContent=data.bot || 'Не настроен';
        const minutes=Math.floor(data.uptimeSeconds/60);$('uptime').textContent=`${Math.floor(minutes/60)} ч ${minutes%60} мин`;
        $('updated').textContent=new Date().toLocaleTimeString('ru-RU');
        if (!modeDirty) document.querySelector(`#mode-form input[value="${data.mode === 'active' ? 'active' : 'observe'}"]`).checked=true;
        modeButton();
    }
    function modeButton() {
        const selected = new FormData($('mode-form')).get('mode');
        $('save-mode').disabled=mutating || !status?.canSetMode || selected === status.mode;
    }
    function params(form) {const values=new URLSearchParams();for(const [name,value] of new FormData(form))if(value.trim())values.set(name,value.trim().replace(/^@/,''));values.set('limit','30');return values;}
    async function refresh() {
        if (!key) return;
        if (refreshing) {refreshQueued=true;return;}
        refreshing=true;$('refresh').disabled=true;
        try {
            const actionQuery=view === 'actions' ? params($('actions-filter')).toString() : 'limit=30';
            const [data,actions,observations]=await Promise.all([api('/status'),api(`/logs/actions?${actionQuery}`),api(`/logs/observations?${params($('observations-filter'))}`)]);
            if (!key) return;
            renderStatus(data);renderActions(actions);renderObservations(observations);
        } finally {refreshing=false;$('refresh').disabled=false;if(refreshQueued){refreshQueued=false;refresh().catch(error=>notify(error.message,true));}}
    }
    function showView(next) {
        if (!Object.hasOwn(views,next)) return;
        view=next;const [name,title,description]=views[next];
        $('page-name').textContent=name;$('page-title').textContent=title;$('page-description').textContent=description;
        document.querySelectorAll('[data-page]').forEach(element=>{element.hidden=element.dataset.page!==next;});
        document.querySelectorAll('.nav-item').forEach(element=>element.classList.toggle('selected',element.dataset.view===next));
        refresh().catch(error=>notify(error.message,true));
    }
    $('login-form').addEventListener('submit',async event=>{
        event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;$('login-error').textContent='';
        key=$('api-key').value.trim();
        try {await refresh();$('api-key').value='';$('login').hidden=true;$('app').hidden=false;$('notice').hidden=true;}
        catch(error){key='';$('login-error').textContent=error.message;}
        finally{button.disabled=false;}
    });
    document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>showView(button.dataset.view)));
    $('open-moderation').addEventListener('click',()=>showView('moderation'));
    $('refresh').addEventListener('click',()=>refresh().catch(error=>notify(error.message,true)));
    $('logout').addEventListener('click',logout);
    $('mode-form').addEventListener('change',()=>{modeDirty=true;$('notice').hidden=true;modeButton();});
    $('mode-form').addEventListener('submit',event=>{
        event.preventDefault();if(mutating)return;const mode=new FormData(event.currentTarget).get('mode');
        pending={type:'mode',mode};$('confirm-title').textContent=mode === 'active' ? 'Включить наказания?' : 'Перейти к наблюдению?';
        $('confirm-text').textContent=mode === 'active' ? 'Бот начнёт автоматически удалять сообщения, выдавать таймауты и предупреждения. Изменение сохранится после перезапуска.' : 'Автоматические действия будут только записываться в журнал. Ручные команды продолжат выполняться.';
        $('confirm-dialog').returnValue='';$('confirm-dialog').showModal();
    });
    $('moderation-form').elements.command.addEventListener('change',event=>{
        const timeout=event.target.value === 'timeout';$('duration-field').hidden=!timeout;$('moderation-form').elements.duration.required=timeout;
    });
    $('moderation-form').addEventListener('submit',event=>{
        event.preventDefault();if(mutating)return;const values=Object.fromEntries(new FormData(event.currentTarget));
        values.username=values.username.replace(/^@/,'').toLowerCase();if(values.command!=='timeout')delete values.duration;
        pending={type:'command',...values};$('confirm-title').textContent=`${actionLabels[values.command]}: @${values.username}`;
        $('confirm-text').textContent=`Причина: ${values.reason}${values.duration ? `\nДлительность: ${values.duration} сек.` : ''}\n\nЭто ручная команда. Она выполняется и в режиме наблюдения.`;
        $('confirm-dialog').returnValue='';$('confirm-dialog').showModal();
    });
    $('confirm-dialog').addEventListener('close',async()=>{
        const request=pending;pending=null;if($('confirm-dialog').returnValue!=='confirm' || !request || mutating || !key)return;
        mutating=true;
        const buttons=[...document.querySelectorAll('#mode-form button,#moderation-form button')];buttons.forEach(button=>button.disabled=true);
        try {
            if(request.type==='mode'){await post('/settings/automod',{mode:request.mode});modeDirty=false;notify('Режим сохранён. Настройка применяется сразу и сохранится после перезапуска.');}
            else {const {type,command,...data}=request;await post(`/command/${command}`,data);notify('Команда обработана. Результат сохранён в журнале действий.');}
            await refresh();
        }catch(error){notify(error.message || 'Ответ не получен. Проверьте журнал перед повтором.',true);}
        finally{mutating=false;buttons.forEach(button=>button.disabled=false);modeButton();}
    });
    for(const id of ['actions-filter','observations-filter']){
        $(id).addEventListener('submit',event=>{event.preventDefault();refresh().catch(error=>notify(error.message,true));});
        $(id).addEventListener('reset',()=>setTimeout(()=>refresh().catch(error=>notify(error.message,true)),0));
    }
    $('close-details').addEventListener('click',()=>$('details-dialog').close());
    setInterval(()=>{if(key && !document.hidden)refresh().catch(error=>notify(`Обновление не выполнено: ${error.message}`,true));},30000);
})();
