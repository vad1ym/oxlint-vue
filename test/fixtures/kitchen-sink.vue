<template>
  <div :class="{ active: isOpen, 'is-dark': theme === 'dark' }">
    <Icon name="menu" />
    <v-select :items="options" @change="onChange($event); track()" />

    <ul>
      <li v-for="(item, index) in items" :key="item.id">
        {{ item.label }} — {{ index }}
      </li>
    </ul>

    <template v-for="[key, group] in grouped" :key="key">
      <section v-if="group.length">
        <DataTable>
          <template #row="{ row: entry }">
            {{ entry.name }}
          </template>
        </DataTable>
      </section>
    </template>

    <input ref="inputRef" v-model="query" v-maska="mask">
    <p v-if="query">{{ query.length > 5 ? 'long' : 'short' }}</p>
    <p v-else-if="loading">…</p>
    <p v-else>{{ '🎉 empty 你好' }}</p>

    <button
      class="btn"
      :disabled="loading"
      @click="submit()"
    >
      Send
    </button>
  </div>
</template>

<script setup lang="ts">
import type { Ref } from 'vue'
import { computed, ref } from 'vue'
import { vMaska } from 'maska/vue'
import Icon from './Icon.vue'
import DataTable from './DataTable.vue'
import VSelect from './VSelect.vue'

interface Item { id: number, label: string }

const props = defineProps<{ theme: string }>()
const emit = defineEmits<{ change: [value: string] }>()

const query = ref('')
const loading = ref(false)
const inputRef = ref<HTMLInputElement | null>(null)
const mask = '###'
const items: Item[] = []
const options = [1, 2, 3]
const grouped = computed(() => new Map<string, Item[]>())
const isOpen = computed(() => query.value.length > 0)

function onChange(value: string) {
  emit('change', value)
}

function track() {}

async function submit() {
  loading.value = true
  try {
    await Promise.resolve()
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.btn {
  color: red;
}
</style>
