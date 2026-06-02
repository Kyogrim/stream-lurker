// Weekly calendar view with manual events and platform-synced schedules.

import { state, appendLogMessage, platformColorVar } from './state.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function eventFormEls() {
  return {
    form: document.getElementById('add-event-form'),
    streamer: document.getElementById('event-streamer'),
    platform: document.getElementById('event-platform'),
    day: document.getElementById('event-day'),
    time: document.getElementById('event-time'),
    title: document.getElementById('event-title'),
  };
}

export function populateCalendarFormDays() {
  const daySelect = document.getElementById('event-day');
  if (!daySelect) return;
  daySelect.innerHTML = '';
  const today = new Date().getDay();
  for (let i = 0; i < 7; i++) {
    const dayVal = (today + i) % 7;
    const option = document.createElement('option');
    option.value = String(dayVal);
    if (i === 0) option.textContent = `Today (${DAY_NAMES[dayVal]})`;
    else if (i === 1) option.textContent = `Tomorrow (${DAY_NAMES[dayVal]})`;
    else option.textContent = DAY_NAMES[dayVal];
    daySelect.appendChild(option);
  }
}

function buildDayColumn(dayVal, label, headerStyle, colStyle) {
  const colDiv = document.createElement('div');
  colDiv.className = 'day-column';
  colDiv.dataset.day = String(dayVal);
  colDiv.style.cssText = colStyle;
  colDiv.innerHTML = `
    <div class="day-name" style="font-size: 0.85rem; font-weight: 700; text-align: center; border-bottom: 1px solid var(--panel-border); padding-bottom: 6px; ${headerStyle}">${label}</div>
    <div class="day-events-list" style="display: flex; flex-direction: column; gap: 8px; flex-grow: 1; overflow-y: auto;"></div>
  `;
  return colDiv;
}

export function renderCalendar() {
  const daysColumnsContainer = document.querySelector('.days-columns');
  if (!daysColumnsContainer) return;
  daysColumnsContainer.innerHTML = '';

  const today = new Date().getDay();
  const baseColStyle = `
    display: flex;
    flex-direction: column;
    gap: 10px;
    background-color: hsla(240, 5.9%, 15%, 0.15);
    border: 1px solid var(--panel-border);
    border-radius: var(--radius-md);
    padding: 10px;
    min-height: 350px;
    transition: var(--transition);
  `;
  const todayColStyle = `
    display: flex;
    flex-direction: column;
    gap: 10px;
    background-color: hsla(142, 70%, 10%, 0.2);
    border: 2px solid #00ff66;
    box-shadow: 0 0 15px rgba(0, 255, 102, 0.15);
    border-radius: var(--radius-md);
    padding: 10px;
    min-height: 350px;
    transition: var(--transition);
  `;
  const tomorrowColStyle = `
    display: flex;
    flex-direction: column;
    gap: 10px;
    background-color: hsla(263, 70%, 10%, 0.2);
    border: 1.5px dashed #8b5cf6;
    border-radius: var(--radius-md);
    padding: 10px;
    min-height: 350px;
    transition: var(--transition);
  `;

  for (let i = 0; i < 7; i++) {
    const dayVal = (today + i) % 7;
    let label = DAY_NAMES[dayVal];
    let headerStyle = 'color: var(--cyan-color);';
    let colStyle = baseColStyle;
    if (i === 0) {
      label = 'Today';
      headerStyle = 'color: #00ff66; text-shadow: 0 0 8px rgba(0, 255, 102, 0.4);';
      colStyle = todayColStyle;
    } else if (i === 1) {
      label = 'Tomorrow';
      headerStyle = 'color: #8b5cf6; text-shadow: 0 0 8px rgba(139, 92, 246, 0.4);';
      colStyle = tomorrowColStyle;
    }
    daysColumnsContainer.appendChild(buildDayColumn(dayVal, label, headerStyle, colStyle));
  }

  const manualEvents = state.currentConfig.calendarEvents || [];
  const allEvents = [...manualEvents, ...state.platformSchedules];
  if (allEvents.length === 0) return;

  allEvents.sort((a, b) => a.time.localeCompare(b.time));

  allEvents.forEach(ev => {
    const dayCol = daysColumnsContainer.querySelector(`.day-column[data-day="${ev.day}"]`);
    const list = dayCol?.querySelector('.day-events-list');
    if (!list) return;

    const isAuto = ev.type === 'auto';
    const platColor = platformColorVar(ev.platform);

    const eventCard = document.createElement('div');
    eventCard.className = `calendar-event-card ${isAuto ? 'auto' : 'manual'}`;
    eventCard.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px;
      background-color: hsla(240, 5.9%, 15%, 0.35);
      border-left: 3px solid ${platColor};
      border-radius: var(--radius-sm);
      font-size: 0.75rem;
      position: relative;
      transition: var(--transition);
      cursor: pointer;
    `;
    eventCard.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; font-weight: 700;">
        <span style="color: var(--text-primary); font-size: 0.72rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 75px;">${ev.streamer}</span>
        <span style="font-family: var(--font-mono); color: var(--cyan-color); font-size: 0.65rem;">${ev.time}</span>
      </div>
      <div style="color: var(--text-secondary); font-size: 0.68rem; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 105px;" title="${ev.title}">${ev.title}</div>
      ${!isAuto ? `
        <button class="delete-event-btn" style="position: absolute; top: 2px; right: 2px; background: none; border: none; color: var(--text-muted); font-size: 0.75rem; cursor: pointer; opacity: 0; transition: var(--transition); line-height: 1;">×</button>
      ` : ''}
    `;

    if (!isAuto) {
      const delBtn = eventCard.querySelector('.delete-event-btn');
      eventCard.addEventListener('mouseenter', () => { delBtn.style.opacity = '1'; });
      eventCard.addEventListener('mouseleave', () => { delBtn.style.opacity = '0'; });
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        state.currentConfig.calendarEvents = state.currentConfig.calendarEvents.filter(event => event.id !== ev.id);
        await window.api.saveConfig(state.currentConfig);
        appendLogMessage(`[Calendar] Removed manual scheduled event for ${ev.streamer}.`);
        renderCalendar();
      });
    }

    list.appendChild(eventCard);
  });
}

export function setupCalendarHandlers() {
  const syncBtn = document.getElementById('sync-calendar-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.innerHTML = `<span class="pulse-dot"></span> Syncing...`;
      try {
        const schedules = await window.api.syncPlatformSchedules();
        state.platformSchedules = schedules;
        state.currentConfig.syncedCalendarEvents = schedules;
        await window.api.saveConfig(state.currentConfig);
        appendLogMessage(`[Calendar] Synced and saved ${schedules.length} platform scheduled streams.`);
        renderCalendar();
      } catch (err) {
        appendLogMessage(`[Calendar] Sync failed: ${err.message}`);
      } finally {
        syncBtn.disabled = false;
        syncBtn.innerHTML = `
          <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 12px; height: 12px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
          Sync Platform Schedules
        `;
      }
    });
  }

  const { form, streamer, platform, day, time, title } = eventFormEls();
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const streamerVal = streamer.value.trim();
    const timeVal = time.value;
    if (!streamerVal || !timeVal) return;

    const newEvent = {
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      streamer: streamerVal,
      platform: platform.value,
      day: parseInt(day.value, 10),
      time: timeVal,
      title: title.value.trim() || 'Custom Lurk Session',
      type: 'manual',
    };

    if (!state.currentConfig.calendarEvents) state.currentConfig.calendarEvents = [];
    state.currentConfig.calendarEvents.push(newEvent);
    await window.api.saveConfig(state.currentConfig);

    streamer.value = '';
    title.value = '';
    time.value = '';

    appendLogMessage(`[Calendar] Added manual event for ${streamerVal} on ${newEvent.platform.toUpperCase()}.`);
    renderCalendar();
  });
}
