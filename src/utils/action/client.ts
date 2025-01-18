// export async function getTaskResultList(): Promise<Task[]> {
//   const supabase = createClient();
//   const { data: { user } } = await supabase.auth.getUser();
//   if (!user) {
//     return [];
//   }

//   const { data: tasks, error } = await supabase
//     .from('tasks')
//     .select('*')
//     .eq('user_id', user.id)
//     .order('created_at', { ascending: false });
  
//   if (error) {
//     console.error('Error fetching tasks:', error);
//     return [];
//   }

//   return tasks;
// }

// export async function uploadImage(image: File) {
//   const form = new FormData();
//   form.append("image", image);
//   form.append("root_path", "redesign/input");
//   form.append("is_compress", "true");

//   const response = await fetch("https://shineai-micro-api-server-y2ph5olwmq-du.a.run.app/upload/image", {
//     method: "POST",
//     body: form,
//   });

//   return response.json(); // 응답을 JSON으로 파싱하여 반환
// }