// "use server";

// import { createClient } from "@/utils/supabase/server";
// import { revalidatePath } from "next/cache";
// import { NextResponse } from "next/server";
// import { Task } from "@/types/processors";
// import { 
//   type NewUsageRecord,
//   type UsageRecord,
//   lemonSqueezySetup,
//   createCheckout, 
//   createUsageRecord,
//   NewWebhook,
//   cancelSubscription as lsCancelSubscription
// } from "@lemonsqueezy/lemonsqueezy.js";

// lemonSqueezySetup({ apiKey: process.env.LEMONSQUEEZY_API_KEY })

// async function incrementUsage(subscriptionItemId: number, quantity: number) {
//   const usageRecord: NewUsageRecord = {
//     action: 'increment',
//     subscriptionItemId,
//     quantity
//   }
//   const { error } = await createUsageRecord(usageRecord);
//   if (error) {
//     console.error("Error creating usage record:", error);
//   }
// }

// export async function cancelSubscription() {
//   const supabase = createClient();
//   const { data: { user } } = await supabase.auth.getUser();
//   if (!user) {
//     throw new Error("User not authenticated");
//   }

//   // Get user's latest subscription from Supabase
//   const { data: subscription, error: subscriptionError } = await supabase
//     .from('subscriptions')
//     .select('*')
//     .eq('user_id', user.id)
//     .order('created_at', { ascending: false })
//     .limit(1)
//     .single();

//   if (subscriptionError || !subscription) {
//     throw new Error("Subscription not found");
//   }

//   if (!subscription.ls_subscription_id) {
//     throw new Error("Invalid subscription ID");
//   }

//   // Cancel subscription in LemonSqueezy only
//   await lsCancelSubscription(subscription.ls_subscription_id);

//   revalidatePath('/dashboard/billing');
//   return { success: true };
// }

// export async function createSubscription(variantId: number, embed = false) {
//   const supabase = createClient();
//   const { data: { user }, error: userError } = await supabase.auth.getUser();
//   if (userError || !user) {
//     throw new Error("User not authenticated");
//   }
  
//   const checkout = await createCheckout(
//     process.env.LEMONSQUEEZY_STORE_ID!,
//     variantId,
//     {
//       checkoutOptions: {
//         embed,
//         media: false,
//         logo: !embed
//       },
//       checkoutData: {
//         email: user.email,
//         custom: {
//           user_id: user.id
//         }
//       },
//       productOptions: {
//         enabledVariants: [variantId],
//         redirectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
//         receiptButtonText: "시작하기",
//         receiptThankYouNote: "결제가 완료되었습니다. 지금 바로 서비스를 이용해보세요"
//       }
//     }
//   )
//   // console.log("CHECKOUT_ERROR", (checkout.data as any).errors);

//   return checkout.data?.data.attributes.url;
// }

// export async function generateInteriorDesign(
//   imageUrl: string,
//   prompt: string,
//   style: string
// ): Promise<Task> {
//   try {
//     const supabase = createClient();
//     console.log("Generating inter₩ior design with:", { imageUrl, prompt, style });

//     const { data: { user }, error: userError } = await supabase.auth.getUser();
//     if (userError || !user) {
//       throw new Error("User not authenticated");
//     }

//     const { data: taskData, error: taskCreateError } = await supabase
//       .from('tasks')
//       .insert({
//         user_id: user.id,
//         processor_name: 'InteriorProcessor',
//         status: 'PENDING',
//         input_data: {
//           imageUrls: [imageUrl],
//           prompt: prompt
//         }
//       })
//       .select('id')
//       .single();

//     if (taskCreateError || !taskData) {
//       console.error("Error creating task:", taskCreateError);
//       throw new Error("Failed to create task");
//     }

//     // `https://webhook.site/c6b46db7-e4b3-4260-870e-5a66ca2f77d1?taskId=${taskData.id}`
//     const response = await fetch('https://api.replicate.com/v1/predictions', {
//       method: 'POST',
//       headers: {
//         'Authorization': `Bearer 8ded0f67c33aeddbfa4a4423d1f791e2cf4c4cda`,
//         'Content-Type': 'application/json'
//       },
//       body: JSON.stringify({
//         version: "2a360362540e1f6cfe59c9db4aa8aa9059233d40e638aae0cdeb6b41f3d0dcce",
//         webhook: `https://www.redesign.im/api/task/callback?taskId=${taskData.id}`,
//         webhook_events_filter: ["completed"],
//         input: {
//           image: imageUrl,
//           prompt: prompt
//         }
//       })
//     });

//     const predictionData = await response.json();
//     if (!predictionData.id) {
//       await supabase
//         .from('tasks')
//         .update({
//           status: 'FAILED',
//           error_message: 'Failed to start prediction'
//         })
//         .eq('id', taskData.id);

//       throw new Error("Failed to start prediction");
//     }

//     const { error: updateError } = await supabase
//       .from('tasks')
//       .update({
//         status: 'PROCESSING'
//       })
//       .eq('id', taskData.id);

//     if (updateError) {
//       console.error('Error updating task with prediction ID:', updateError);
//     }

//     const { data: subscription } = await supabase
//       .from('subscriptions')
//       .select('ls_subscription_item_id, ls_subscription_item_quantity')
//       .eq('user_id', user.id)
//       .single();

//     await supabase
//       .from('subscriptions')
//       .update({ ls_subscription_item_quantity: (subscription?.ls_subscription_item_quantity || 0) + 1 })
//       .eq('user_id', user.id);

//     await incrementUsage(subscription?.ls_subscription_item_id, 1);

//     return {
//       id: taskData.id,
//       processor_name: 'InteriorProcessor',
//       status: 'PROCESSING',
//       input_data: {
//         image_url: imageUrl
//       },
//       created_at: new Date().toISOString()
//     } as Task;


//     // if (data.id) {
//     //   // Save the task to the database
//     //   const { data: taskData, error } = await supabase
//     //     .from('tasks')
//     //     .insert({
//     //       prediction_id: data.id,
//     //       image_url: imageUrl,
//     //       prompt: prompt,
//     //       style: style,
//     //       status: 'PENDING'
//     //     });

//     //   if (error) {
//     //     console.error("Error saving task to database:", error);
//     //     throw new Error("Failed to save task to database");
//     //   }

//     //   revalidatePath("/dashboard/interior");
//     //   return { success: true, predictionId: data.id };
//     // } else {
//     //   throw new Error("Failed to start prediction");
//     // }
//     // console.log("Prediction started:", data);

//     // if (data.id) {
//     //   revalidatePath("/dashboard/interior");
//     //   return { success: true, predictionId: data.id };
//     // } else {
//     //   throw new Error("Failed to start prediction");
//     // }
//   } catch (error) {
//     console.error("Error generating interior design:", error);
//     throw error;
//   }
// }