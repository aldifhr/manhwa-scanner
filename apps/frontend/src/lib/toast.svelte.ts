import { writable } from "svelte/store";
export type ToastType = "success"|"error"|"info";
export interface ToastItem { id:number; message:string; type:ToastType }
const store = writable<ToastItem[]>([]);
let nid=0;
export function toast(message:string, type:ToastType="success") {
  const item: ToastItem = { id: ++nid, message, type };
  store.update(a=>[...a, item]);
  setTimeout(()=> store.update(a=>a.filter(i=>i.id!==item.id)), 3000);
}
export const toasts = store;
