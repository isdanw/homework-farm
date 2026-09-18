/**
 * 打卡类型管理（家长工具）
 *  · 内置类型（语/数/英）只读展示，不可删
 *  · 自定义类型：家长增 / 删 / 改（名称、图标、配色、作物造型），落盘到当前孩子的 checkinTypes
 *  · 首页、打卡页、农场页都通过 store.getTypeList() 合并「内置 + 自定义」自动生效
 */
const store = require('../../utils/store.js');
const CFG = require('../../utils/config.js');

const EMOJIS = ['📚','🔢','🔤','📖','🏃','🎹','🧹','😴','🎨','⚽','🎵','💡','🌟','🍎','✏️','🧠','💪','🌈','🚀','🐱'];
const COLORS = [
  { color:'#FFB3C6', colorDeep:'#FF8FAE' },
  { color:'#9AD5FF', colorDeep:'#5FB6F5' },
  { color:'#A8E6A1', colorDeep:'#6FCF7C' },
  { color:'#FFD98E', colorDeep:'#F5B740' },
  { color:'#C9B6FF', colorDeep:'#A07CE0' },
  { color:'#FFB38A', colorDeep:'#F2845C' },
  { color:'#8FE3D6', colorDeep:'#4FC4B0' },
  { color:'#FF9EC4', colorDeep:'#E85A9B' }
];
const SHAPES = [
  { key:'flower', name:'🌸 花' },
  { key:'berry', name:'🫐 果' },
  { key:'leaf', name:'🍃 叶' }
];

Page({
  data: {
    builtinTypes: [],
    customTypes: [],
    emojis: EMOJIS,
    colors: COLORS,
    shapes: SHAPES,
    showForm: false,
    editingId: '',
    form: { name:'', emoji:'📖', color:'#9AD5FF', colorDeep:'#5FB6F5', shape:'flower' },
    preview: {}
  },

  onShow() { this.render(); },

  render() {
    const u = store.get();
    const custom = (u && Array.isArray(u.checkinTypes)) ? u.checkinTypes : [];
    const builtin = CFG.SUBJECTS.map(s => ({
      key: s.key,
      name: s.name, emoji: s.emoji || s.icon, color: s.color, colorDeep: s.colorDeep,
      cropName: s.cropName, seedName: s.seedName
    }));
    this.setData({ builtinTypes: builtin, customTypes: custom });
  },

  goBack() { wx.navigateBack({ delta: 1 }); },

  /* ======================= 学科画像 ======================= */
  goSubjectProfile(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    wx.navigateTo({ url: '/pkgGuide/typeProfile/typeProfile?key=' + key });
  },

  /* ======================= 表单 ======================= */
  buildPreview(f) {
    const name = f.name || '打卡项';
    return {
      name, emoji: f.emoji, color: f.color, colorDeep: f.colorDeep, shape: f.shape,
      bg: `linear-gradient(135deg, ${f.color} 0%, ${f.colorDeep} 100%)`,
      seedName: name + '种子', cropName: name + '苗'
    };
  },

  openAdd() {
    const form = { name:'', emoji: EMOJIS[4], color: COLORS[1].color, colorDeep: COLORS[1].colorDeep, shape: 'flower' };
    this.setData({ showForm: true, editingId: '', form, preview: this.buildPreview(form) });
  },

  openEdit(e) {
    const id = e.currentTarget.dataset.id;
    const t = this.data.customTypes.find(x => x.id === id);
    if (!t) return;
    const form = { name: t.name, emoji: t.emoji, color: t.color, colorDeep: t.colorDeep, shape: t.shape };
    this.setData({ showForm: true, editingId: id, form, preview: this.buildPreview(form) });
  },

  closeForm() { this.setData({ showForm: false }); },
  noop() {},  // 弹窗内层 catchtap 拦截用，避免点击表单内部冒泡到遮罩导致弹窗关闭

  // 输入名称：model:value 在真机自动把值同步进 this.data.form.name（键盘/光标更稳）；
  // 这里仍显式 setData form.name，保证低版本基础库也能正常保存（不依赖 model:value）。
  onName(e) {
    const raw = (e.detail && e.detail.value != null) ? e.detail.value : (this.data.form && this.data.form.name) || '';
    const name = String(raw || '');
    const form = Object.assign({}, this.data.form, { name });
    this.setData({ form, preview: this.buildPreview(form) });
  },
  pickEmoji(e) {
    const emoji = e.currentTarget.dataset.emoji;
    const form = Object.assign({}, this.data.form, { emoji });
    this.setData({ form, preview: this.buildPreview(form) });
  },
  pickColor(e) {
    const c = COLORS[e.currentTarget.dataset.i];
    const form = Object.assign({}, this.data.form, { color: c.color, colorDeep: c.colorDeep });
    this.setData({ form, preview: this.buildPreview(form) });
  },
  pickShape(e) {
    const shape = e.currentTarget.dataset.shape;
    const form = Object.assign({}, this.data.form, { shape });
    this.setData({ form, preview: this.buildPreview(form) });
  },

  confirmForm() {
    const f = this.data.form;
    const name = (f.name || '').trim();
    if (!name) return wx.showToast({ title: '先给打卡项起个名字', icon: 'none' });

    const u = store.get();
    if (!u.checkinTypes) u.checkinTypes = [];
    const id = this.data.editingId || ('ct_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36));
    const rec = {
      id: id, key: id, name: name, emoji: f.emoji,
      color: f.color, colorDeep: f.colorDeep, shape: f.shape,
      seedName: name + '种子', cropName: name + '苗', coin: 8, builtin: false
    };

    if (this.data.editingId) {
      const idx = u.checkinTypes.findIndex(x => x.id === this.data.editingId);
      if (idx >= 0) u.checkinTypes[idx] = rec;
    } else {
      u.checkinTypes.push(rec);
    }
    store.save(u);
    this.setData({ showForm: false });
    this.render();
    wx.showToast({ title: this.data.editingId ? '已更新' : '已添加', icon: 'success' });
  },

  removeType(e) {
    const id = e.currentTarget.dataset.id;
    const t = this.data.customTypes.find(x => x.id === id);
    if (!t) return;
    wx.showModal({
      title: '删除打卡类型',
      content: '确定删除「' + t.name + '」吗？已打卡的这一类型记录会保留，只是不再出现在打卡列表里。',
      confirmColor: '#FF7A7A',
      success: (res) => {
        if (!res.confirm) return;
        const u = store.get();
        u.checkinTypes = (u.checkinTypes || []).filter(x => x.id !== id);
        store.save(u);
        this.render();
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  }
});
