'use strict';

/**
 * 自动续期调度器：默认每 12 小时触发一次 certbot renew，
 * certbot 自身只在证书剩余天数低于阈值时才真正续期。
 */
class Scheduler {
  constructor({ config, manager, logger }) {
    this.config = config.scheduler;
    this.manager = manager;
    this.log = logger;
    this.timer = null;
    this.lastRun = null;
    this.lastResult = null;
  }

  start() {
    if (!this.config.enabled) {
      this.log.info('自动续期调度未启用 (scheduler.enabled=false)');
      return;
    }
    const intervalMs = Math.max(5, Number(this.config.intervalMinutes) || 720) * 60 * 1000;
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => this.log.error('续期任务异常', err));
    }, intervalMs);
    this.timer.unref?.();
    this.log.info(`自动续期调度已启动，间隔 ${intervalMs / 60000} 分钟`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce() {
    this.lastRun = new Date().toISOString();
    this.log.info('开始执行证书续期检查');
    const result = await this.manager.renewCertificates();
    this.lastResult = { at: this.lastRun, ok: result.ok, detail: result.detail };
    if (result.ok) this.log.info('续期检查完成');
    else this.log.warn('续期检查未成功', result.detail);
    return this.lastResult;
  }
}

module.exports = { Scheduler };
