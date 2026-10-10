/**
 * 打卡日历页（日 / 周 / 月 三种视图，均为「查看」用途）
 *  —— 日模式：今日三科打卡状态（完成/待打卡 + 时间）+ 今晚农场预告
 *  —— 周模式：本周（周一~周日）每天三科打卡状态
 *  —— 月模式：本月日历热力图，每天展示三科完成数（0/3 着色）
 *  注：实际「打卡」动作在首页（成长乐园）点图标完成，本页只做查看与回顾。
 *  AI 导学评价的统一入口在「打卡详情页（checkinDetail）」，本页仅只读展示对应科目的分析结果。
 */
const store = require('../../utils/store.js');
const engine = require('../../utils/farmEngine.js');
const util = require('../../utils/util.js');
const CFG = require('../../utils/config.js');

/** 完成数 → 月历格子底色（按总类型数比例着色，支持任意数量打卡类型） */
function monthTint(done, total) {
  if (total > 0 && done >= total) return '#A6DEA0';
  if (done >= Math.ceil(total * 2 / 3)) return '#C8E9BE';
  if (done > 0) return '#E4F3DF';
  return '#F4F7FA';
}

Page({
  data: {
    mode: 'day',                      // day | week | month

    /* —— 日模式 —— */
    selDate: '',                      // 日视图当前查看日期（空 = 今天）；可选历史日期
    selDateText: '',                  // 展示用，如 "8月13日 星期四（历史）"
    todayDate: '',                    // 日期选择器上限（今天）
    selIsToday: true,                 // 当前是否看今天
    cards: [],                        // 当日打卡状态（只读）
    doneNum: 0,
    typeTotal: 3,                     // 当前激活打卡类型总数（动态）
    forecast: {},

    /* —— 周模式 —— */
    weekCols: [],                    // 7 列：{ key,label,date,isToday, dots:[{name,color,colorDeep,on}] }
    weekSubjects: [],                // 图例：[{ name, color }]
    weekFullDays: 0,                 // 本周三科全勤天数

    /* —— 月模式 —— */
    monthTitle: '',
    monthCells: [],                  // 42 格：{ key,day,inMonth,done,color,isToday,commentCount }
    monthFullDays: 0,                // 本月三科全勤天数
    monthTotal: 0                    // 本月总天数
  },

  onLoad() {
    this._onChange = () => this.render();
    store.on(this._onChange);
  },
  onUnload() { store.off(this._onChange); },

  onShow() {
    if (this.getTabBar) { const tb = this.getTabBar(); if (tb) tb.setData({ selected: 1 }); }
    getApp().runDailyRollover();
    this.render();
  },

  /* 切换 日 / 周 / 月 */
  switchMode(e) {
    const m = e.currentTarget.dataset.m;
    if (m === this.data.mode) return;
    this.setData({ mode: m });
  },

  /* 日视图：选择历史日期 */
  onPickDate(e) {
    const v = e.detail.value;              // 'YYYY-MM-DD'
    if (v === this.data.selDate) return;
    this.setData({ selDate: v });
    this.render();
  },

  /* 日视图：回到今天 */
  backToToday() {
    this.setData({ selDate: '' });
    this.render();
  },

  render() {
    const d = store.get();
    const today = util.today();

    /* ===== 老师评语：按日期聚合（日 / 周 / 月视图共用） ===== */
    const allComments = store.getComments();          // 已倒序（最新在前）
    const byDate = {};
    allComments.forEach(c => { (byDate[c.date] = byDate[c.date] || []).push(c); });
    this._byDate = byDate;
    const viewDate = this.data.selDate || today;
    const isViewToday = viewDate === today;

    /* ===== 日模式：当日打卡状态（只读，支持查看历史日期） ===== */
    const hw = engine.ensureDay(d, viewDate);
    const types = store.getTypeList();
    const typeTotal = types.length;
    const cards = types.map(s => ({
      key: s.key, name: s.name, icon: s.icon, color: s.color, colorDeep: s.colorDeep,
      done: hw[s.key].done,
      minutes: hw[s.key].minutes,
      timeText: hw[s.key].doneAt ? formatTime(hw[s.key].doneAt) : '',
      analysis: (hw[s.key] && hw[s.key].analysis) || ''   // 对应科目的 AI 导学评价（只读展示）
    }));

    /* ===== 周模式：本周每天打卡状态 ===== */
    const weekKeys = util.weekDates(today);
    const weekCols = weekKeys.map(k => {
      const rec = d.homework[k];
      return {
        key: k,
        label: util.weekdayShort(k),
        date: k.slice(5).replace('-', '/'),
        isToday: k === today,
        commentCount: (byDate[k] || []).length,
        dots: types.map(s => ({
          name: s.name, color: s.color, colorDeep: s.colorDeep,
          on: !!(rec && rec[s.key] && rec[s.key].done)
        }))
      };
    });
    const weekFullDays = weekKeys.filter(k => {
      const rec = d.homework[k];
      return rec && engine.getSubKeys().every(x => rec[x] && rec[x].done);
    }).length;
    const weekSubjects = types.map(s => ({ name: s.name, color: s.color }));

    /* ===== 月模式：本月日历热力图 ===== */
    const monthCellsRaw = util.monthMatrix(today);
    const monthCells = monthCellsRaw.map(c => {
      const rec = d.homework[c.key];
      const done = rec ? engine.getSubKeys().filter(x => rec[x] && rec[x].done).length : 0;
      return {
        key: c.key, day: c.day, inMonth: c.inMonth, done: done,
        color: monthTint(done, typeTotal), isToday: c.key === today,
        commentCount: (byDate[c.key] || []).length
      };
    });
    const monthFullDays = monthCells.filter(c => c.inMonth && c.done === typeTotal).length;
    const monthTotal = monthCells.filter(c => c.inMonth).length;

    this.setData({
      selDate: viewDate,
      todayDate: today,
      selIsToday: isViewToday,
      selDateText: util.cnDate(viewDate) + ' ' + util.weekday(viewDate) + (isViewToday ? '' : '（历史）'),
      child: { avatar: d.avatar, nickname: d.nickname, grade: d.grade },
      cards,
      doneNum: cards.filter(c => c.done).length,
      typeTotal,
      forecast: engine.forecast(d),

      weekCols, weekSubjects, weekFullDays,
      monthTitle: util.cnYearMonth(today) + '打卡',
      monthCells, monthFullDays, monthTotal
    });
  },

  goFarm() { wx.switchTab({ url: '/pages/farm/farm' }); },
  goIndex() { wx.switchTab({ url: '/pages/index/index' }); },
  switchChild() { wx.switchTab({ url: '/pages/mine/mine' }); },

  noop() {}
});

function formatTime(ts) {
  const t = new Date(ts);
  return util.pad(t.getHours()) + ':' + util.pad(t.getMinutes());
}
