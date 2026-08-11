/**
 * 通用工具函数：日期处理 / ID 生成 / 轻提示
 */

/** 补零 */
function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 取某个 Date 的 YYYY-MM-DD */
function dateKey(d) {
  const t = d || new Date();
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** 今天的 YYYY-MM-DD */
function today() {
  return dateKey(new Date());
}

/** N 天前（N 为正数）的 YYYY-MM-DD */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dateKey(d);
}

/** 昨天 */
function yesterday() {
  return daysAgo(1);
}

/** 'YYYY-MM-DD' → MM月DD日 */
function cnDate(key) {
  if (!key) return '';
  const p = key.split('-');
  return `${Number(p[1])}月${Number(p[2])}日`;
}

/** 中文星期 */
function weekday(key) {
  const names = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const d = key ? new Date(key.replace(/-/g, '/')) : new Date();
  return names[d.getDay()];
}

/** 两个日期字符串相差的天数（a - b） */
function diffDays(a, b) {
  const t1 = new Date(a.replace(/-/g, '/')).getTime();
  const t2 = new Date(b.replace(/-/g, '/')).getTime();
  return Math.round((t1 - t2) / 86400000);
}

/** 当前是否已进入「夜晚」（小狗熊出没时间） */
function isNight(nightHour) {
  return new Date().getHours() >= (nightHour || 19);
}

/** 简易唯一 ID */
function uid(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 轻提示 */
function toast(title, icon) {
  wx.showToast({ title: title, icon: icon || 'none', duration: 1800 });
}

module.exports = {
  pad, dateKey, today, daysAgo, yesterday, cnDate, weekday, diffDays, isNight, uid, toast
};
