/**
 * examApi.js —— 小程序端调用 examService 云函数的统一封装
 * 动作：gen / grade / listExams / getExam / saveExam / deleteExam / listSubmissions /
 *      listProviders / testVision / saveVisionConfig
 * 试卷与批改提交由 examService 云端直连读写（已含跨设备 pull/push），
 * 不经过 tutorSync，避免与现有导学同步体系耦合。
 */
function call(action, data) {
  return new Promise(function (resolve) {
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
      return resolve({ ok: false, code: 'no_cloud', msg: '未连接云端' });
    }
    wx.cloud.callFunction({
      name: 'examService',
      data: Object.assign({ action: action }, data || {})
    }).then(function (res) {
      resolve((res && res.result) || { ok: false, code: 'no_result', msg: '云端无返回' });
    }).catch(function (e) {
      resolve({ ok: false, code: 'network', msg: (e && e.errMsg) || '调用失败' });
    });
  });
}

const EXAM = {
  genExam: function (p) { return call('gen', p); },
  gradeExam: function (p) { return call('grade', p); },
  /* 单孩子模型：不传 childId，云端按当前孩子解析归属 */
  listExams: function (subject) { return call('listExams', { subject: subject || '' }); },
  getExam: function (resourceId) { return call('getExam', { resourceId: resourceId }); },
  saveExam: function (exam) { return call('saveExam', { exam: exam }); },
  deleteExam: function (resourceId) { return call('deleteExam', { resourceId: resourceId || '' }); },
  listSubmissions: function (examClientId) { return call('listSubmissions', { examClientId: examClientId || '' }); },
  getSubmission: function (submissionClientId) { return call('getSubmission', { submissionClientId: submissionClientId }); },
  listProviders: function () { return call('listProviders', {}); },
  testVision: function (p) { return call('testVision', p); },
  saveVisionConfig: function (p) { return call('saveVisionConfig', p); },

  /* ---------------- 教材库（textbook_library） ---------------- */
  listTextbooks: function (p) { return call('listTextbooks', p || {}); },
  getTextbook: function (textbookId) { return call('getTextbook', { textbookId: textbookId || '' }); },
  saveTextbook: function (textbook) { return call('saveTextbook', { textbook: textbook }); },
  deleteTextbook: function (textbookId) { return call('deleteTextbook', { textbookId: textbookId || '' }); },
  parseTextbookPdf: function (p) { return call('parseTextbookPdf', p || {}); },
  parseTextbookText: function (p) { return call('parseTextbookText', p || {}); },
  searchTextbook: function (p) { return call('searchTextbook', p || {}); },

  /** COS 直传（与 iPad 同链路）：signUpload 拿临时凭证 → wx.request PUT。
   *  kind: 'page' | 'handwriting' | 'textbook_pdf'；返回 Promise<fileId>。
   *  ⚠️ header 必须 4 件套：Authorization / Content-Type / x-cos-meta-fileid / x-cos-security-token。
   *     x-cos-meta-fileid 参与 COS 临时密钥签名，漏带即 403 SignatureDoesNotMatch（2026-10-25 线上实测）。 */
  uploadFile: function (filePath, kind, ext, onProgress) {
    const self = this;
    return EXAM.signUpload(kind, ext).then(function (signRes) {
      if (!signRes || !signRes.ok) return Promise.reject(new Error((signRes && signRes.msg) || '获取上传签名失败'));
      const up = signRes.upload || {};
      // ⚠️ wx.request 不支持 filePath / name（那是 wx.uploadFile 的 multipart 参数），
      //    直接传会被忽略且 data 为空 → PUT 空体 → COS 存 0 字节 → 云端报「PDF 文件为空」。
      //    COS 直传必须是裸 PUT（multipart POST 必 403），故先读成 ArrayBuffer 走 data 发送。
      let body = '';
      try {
        body = wx.getFileSystemManager().readFileSync(filePath);
      } catch (e) {
        return Promise.reject(new Error('读取文件失败：' + ((e && e.errMsg) || e)));
      }
      return new Promise(function (resolve, reject) {
        wx.request({
          url: up.url,
          method: 'PUT',
          data: body,
          timeout: 120000,
          header: {
            'Authorization': up.authorization || '',
            'Content-Type': ext === 'pdf' ? 'application/pdf' : 'image/jpeg',
            // x-cos-meta-fileid 参与 COS 签名，漏带必 403 SignatureDoesNotMatch（iPad 端同款 4 header）
            'x-cos-meta-fileid': up.cosFileId || up.fileId || '',
            'x-cos-security-token': up.token || ''
          },
          success: function (r) {
            if (r.statusCode >= 200 && r.statusCode < 300) resolve(up.fileId || up.cosFileId || up.cloudPath || '');
            else reject(new Error('上传失败（HTTP ' + r.statusCode + '）'));
          },
          fail: function (e) { reject(new Error((e && e.errMsg) || '上传失败')); }
        });
      });
    }).then(function (fileId) {
      if (!fileId) throw new Error('上传成功但未取得 fileId');
      return fileId;
    });
  },
  signUpload: function (kind, ext) { return call('signUpload', { kind: kind || 'page', ext: ext || 'jpg' }); },

  /* 批改结果暂存（提交后直传报告页，避免大对象走 URL 参数） */
  _lastGrade: null,
  setLastGrade: function (g) { EXAM._lastGrade = g; },
  getLastGrade: function () { return EXAM._lastGrade; },

  /* 同批试卷暂存（报告页需题目原文 stem/选项，而 grade 结果不含，故一并暂存） */
  _lastExam: null,
  setLastExam: function (e) { EXAM._lastExam = e; },
  getLastExam: function () { return EXAM._lastExam; }
};

module.exports = EXAM;
