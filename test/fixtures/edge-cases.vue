<template>
  <div>
    <span>{{ /[0-9]+/u.test(code) }}</span>
    <i v-for="n in 5" :key="n">{{ n }}</i>
    <b
      :title="veryLongConditionName ? 'aaaaaaaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbbbbbbbb'"
      :style="{ width: `${size}px` }"
    >multi-line attrs</b>
    <em @click="a = 1; b = 2">multi statement</em>
    <Tight/>
    <textarea v-model="note" />
  </div>
</template>

<script setup>
const code = '42'
const size = 10
const veryLongConditionName = true
let a = 0
let b = 0
const note = ''
</script>
