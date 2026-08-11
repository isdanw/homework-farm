/**
 * 自定义底部导航（5 栏）
 * 用自定义 tabBar 的好处：图标全部用 CSS 手绘，不需要任何图片文件，
 * 而且可以在「我的农场」上显示未完成作业的红点警告。
 */
const store = require('../utils/store.js');
const engine = require('../utils/farmEngine.js');

Component({
  data: {
    selected: 0,
    warn: false,          // 农场页红点：今天还有作业没写完
    list: [
      { pagePath: '/pages/index/index',   text: '每日计划', icon: 'plan' },
      { pagePath: '/pages/checkin/checkin', text: '作业打卡', icon: 'check' },
      { pagePath: '/pages/stats/stats',   text: '学习统计', icon: 'stats' },
      { pagePath: '/pages/errors/errors', text: '错题本',   icon: 'book' },
      { pagePath: '/pages/farm/farm',     text: '我的农场', icon: 'farm' }
    ]
  },

  lifetimes: {
    attached() {
      this.refreshWarn();
      this._onChange = () => this.refreshWarn();
      store.on(this._onChange);        // 数据变化实时刷新红点
    },
    detached() {
      store.off(this._onChange);
    }
  },

  methods: {
    refreshWarn() {
      const d = store.get();
      const missing = engine.missingSubjects(d, require('../utils/util.js').today());
      this.setData({ warn: missing.length > 0 });
    },
    switchTab(e) {
      const i = e.currentTarget.dataset.index;
      const url = this.data.list[i].pagePath;
      wx.switchTab({ url });
      this.setData({ selected: i });
    }
  }
});
