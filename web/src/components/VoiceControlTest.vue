<template>
  <div class="voice-control-test">
    <div class="test-header">
      <button
        type="button"
        class="btn-secondary"
        :disabled="disabled || pending"
        @click="runTest"
      >
        {{ pending ? '测试中...' : '测试语音配置' }}
      </button>
      <span class="test-helper">先保存设置。测试使用一段内置录音（配置了 TTS 模型时会测试合成），不会执行播放命令，也不会在频道播放。</span>
    </div>

    <p v-if="requestError" class="test-error">{{ requestError }}</p>

    <div v-if="results.length" class="test-results" role="status">
      <div
        v-for="row in results"
        :key="row.stage"
        class="test-row"
        :class="row.ok ? 'is-ok' : 'is-fail'"
      >
        <div class="row-head">
          <span class="row-stage">{{ stageLabels[row.stage] }}</span>
          <span class="row-badge" :class="row.ok ? 'badge-ok' : 'badge-fail'">
            {{ row.ok ? '通过' : '失败' }}
          </span>
        </div>
        <div class="row-detail">{{ row.message }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import axios from 'axios'

defineProps({
  disabled: {
    type: Boolean,
    default: false
  }
})

const stageLabels = {
  wake: '本地唤醒模型',
  asr: '云端语音转写',
  llm: 'LLM 工具调用',
  tts: '语音合成（TTS）'
}
type TestResult = { stage: keyof typeof stageLabels; ok: boolean; message: string }

const pending = ref(false)
const requestError = ref('')
const results = ref<TestResult[]>([])

async function runTest() {
  pending.value = true
  requestError.value = ''
  results.value = []

  try {
    const { data } = await axios.post<{ results: TestResult[] }>('/api/bot/settings/voice-control/test')
    results.value = data.results
  } catch (error) {
    requestError.value = (axios.isAxiosError<{ error?: string }>(error) && error.response?.data.error)
      || '语音配置测试请求失败'
  } finally {
    pending.value = false
  }
}
</script>

<style scoped>
.voice-control-test {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-subtle, var(--border-color, rgba(255, 255, 255, 0.1)));
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.test-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.test-helper {
  font-size: 12px;
  color: var(--text-secondary, var(--text-muted, #94a3b8));
}

.test-error {
  margin: 0;
  font-size: 13px;
  color: var(--danger, var(--error-color, #ef4444));
}

.test-results {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.test-row {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-secondary, var(--surface-muted, rgba(255, 255, 255, 0.04)));
  border: 1px solid var(--border-subtle, var(--border-color, rgba(255, 255, 255, 0.08)));
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.row-stage {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, inherit);
}

.row-badge {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
}

.badge-ok {
  color: var(--success, #22c55e);
  background: rgba(34, 197, 94, 0.12);
}

.badge-fail {
  color: var(--danger, #ef4444);
  background: rgba(239, 68, 68, 0.12);
}

.row-detail {
  font-size: 12px;
  color: var(--text-secondary, #cbd5e1);
  word-break: break-word;
}

</style>
