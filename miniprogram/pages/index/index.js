/**
 * 成长乐园（首页）→ 三科打卡入口枢纽
 *  · 吉祥物问候 + 今日三科打卡状态（数据层实时同步）
 *  · 三个打卡图标：点击语文 / 数学 / 英语 直接完成当日打卡，联动农场奖励
 *  · 家长工具（导出/导入/清空示例）已移至「我的」页
 */
const store = require('../../utils/store.js');
const engine = require('../../utils/farmEngine.js');
const sched = require('../../utils/scheduleEngine.js');
const studyPlan = require('../../utils/studyPlan.js');
const util = require('../../utils/util.js');
const CFG = require('../../utils/config.js');

// 打卡类型由 store.getTypeList() 动态生成（内置 3 科 + 家长自定义），磁贴用各自配色做渐变
// 中深色作主色，保证磁贴明显是彩色的（不接近白底），配合深色名称文字清晰可读
function tileBg(t) {
  return `linear-gradient(160deg, ${t.colorDeep} 0%, ${t.color} 100%)`;
}

Page({
  data: {
    dateText: '', weekText: '', streak: 0,
    doors: [],
    total: 3, doneNum: 0, leftNum: 0, allDone: false, percent: 0,
    farm: { coins: 0, suns: 0, bears: 0, pesticide: 0 },
    seedsTotal: 0,
    forecast: {},
    todayCoursesText: '',       // 今日课表（有课表时展示，如「语文 · 数学 · 体育」）
    pendingMistakes: 0          // 待订正错题数（今日中枢待办提醒，0 则隐藏）
  },

  onLoad() {
    this._onChange = () => this.render();
    store.on(this._onChange);
  },
  onUnload() { store.off(this._onChange); },

  onShow() {
    if (this.getTabBar) {
      const tb = this.getTabBar();
      if (tb) tb.setData({ selected: 0 });
    }
    getApp().runDailyRollover();
    this.render();
  },

  render() {
    const d = store.get();
    const today = util.today();
    const hw = engine.ensureDay(d, today);

    const types = store.getTypeList();
    const doors = types.map(t => {
      const done = hw[t.key].done;
      // 单向读取成长计划：磁贴展示「最近一条未勾选的任务」（无需先点「开始计划」）
      let planTask = '';
      try {
        const cur = studyPlan.getCurrentTask(t.key);
        if (cur) planTask = cur.name;
      } catch (e) {}
      return {
        key: t.key, name: t.name, emoji: t.emoji || t.icon,
        bg: tileBg(t),
        done, status: done ? '已完成 ✓' : '未开始',
        planTask
      };
    });
    const doneNum = doors.filter(x => x.done).length;
    const total = types.length;
    const seeds = d.farm.seeds || {};
    const seedsTotal = Object.keys(seeds).reduce((s, k) => s + (seeds[k] || 0), 0);

    // 课表联动：今天的课程（去重后拼接，如「语文 · 数学 · 体育」）
    let todayCoursesText = '';
    try {
      const seen = {};
      const names = [];
      sched.todayCourses(sched.getSchedule()).forEach(c => {
        if (!seen[c.name]) { seen[c.name] = 1; names.push(c.name); }
      });
      todayCoursesText = names.join(' · ');
    } catch (e) {}

    // 成长计划摘要：任一科目已有计划 → 显示其状态；否则引导生成
    let planEntryText = '按年级、学期与教材为各科编排阶段任务，打卡自动带出当前待完成任务';
    try {
      for (const t of store.getTypeList()) {
        const prog = studyPlan.getProgress(t.key);
        if (prog) {
          planEntryText = t.name + '计划：' + prog.statusText +
            (prog.started && prog.devDays !== 0
              ? (prog.devDays > 0 ? '（领先 ' + prog.devDays + ' 天）' : '（落后 ' + (-prog.devDays) + ' 天）')
              : '') + ' · ' + prog.doneCount + '/' + prog.totalTasks + ' 项';
          break;
        }
      }
    } catch (e) {}

    // 待订正错题数（今日中枢：待办提醒，有才显示，无则不打扰）
    let pendingMistakes = 0;
    try {
      const tutorStore = require('../../utils/tutorStore.js');
      pendingMistakes = tutorStore.getMistakes().filter(m => m.status !== 'corrected').length;
    } catch (e) {}

    this.setData({
      dateText: util.cnDate(today),
      weekText: util.weekday(today),
      streak: d.profile.streak,
      child: { avatar: d.avatar, nickname: d.nickname, grade: d.grade },
      doors,
      total,
      doneNum,
      leftNum: total - doneNum,
      allDone: doneNum === total,
      percent: Math.round(doneNum / total * 100),
      farm: { coins: d.farm.coins, suns: d.farm.suns, bears: d.farm.bears.length, pesticide: d.farm.pesticide },
      seedsTotal,
      todayCoursesText,
      planEntryText,
      pendingMistakes,
      forecast: engine.forecast(d)
    });
  },

  /* 点击打卡图标 → 进入打卡详情页（写打卡情况 + AI 分析后完成打卡） */
  openCheckin(e) {
    const key = e.currentTarget.dataset.key;
    wx.navigateTo({ url: '/pkgTools/checkinDetail/checkinDetail?key=' + key });
  },

  goFarm() { wx.switchTab({ url: '/pages/farm/farm' }); },
  goMistakes() { wx.navigateTo({ url: '/pkgTools/mistakes/mistakes' }); },
  goPlan() {
    const first = store.getTypeList()[0];
    wx.navigateTo({ url: '/pkgTools/plan/plan' + (first ? '?key=' + first.key : '') });
  }
});
