# PAPO Postman collection

Import `PAPO.postman_collection.json` into Postman. Start the local app with `npm run dev` and leave `baseUrl` as `http://127.0.0.1:8787`. For another deployment, set `baseUrl` to that API origin without a trailing slash. The cloud environment is currently paused; the collection has not been tested against it.

## Set up

1. Use **Auth → Login** with the local admin email and password from the ignored `.local/api/admin.json`. Put them in Postman's local/current variable values; do not save real credentials in a shared collection or exported environment. Postman's cookie jar carries the HttpOnly session cookie on later admin requests. Admin POSTs include `Origin: {{baseUrl}}` and JSON content type.
2. Run **Admin → Workspace** and copy the desired business ID to `tenantId` and site ID to `siteId`. The workspace can contain more than one business.
3. Use **Admin → Enroll booth** or copy an existing booth credential from the ignored local fixture `.local/api/credentials.json`. Put the credential in the local/current value of `deviceCredential`. Booth requests use `Authorization: Bearer {{deviceCredential}}`; the admin session cookie cannot replace it.
4. Use **Admin → Publish frame**, then **Admin → Publish configuration** for that booth. The collection saves nonsecret response IDs and the desired configuration version as collection variables. Set these manually if you are using existing records. Check **Device → Configuration**, then acknowledge the version with **Device → Configuration applied** after the booth has applied it.
5. Use **Admin → Issue voucher** or the **Local development → Issue local test voucher** request. Copy the returned `code` into the local/current value of `voucherCode`. It is single use. Use **Device → Create voucher session** to redeem it.

The provisioning and device requests have pre-request scripts that generate UUIDs with Postman's `{{$guid}}` helper. Each request saves its own generated `request_id`, `event_id`, `client_session_id`, or `client_job_id` as a collection variable. Sending the same request again reuses its UUID for an idempotent retry; keep the request body identical. To start a *new* operation, clear that request's generated UUID variable in the collection's Variables tab before sending it again. For a new voucher, clear `issueVoucherRequestId` and `voucherExpiresAt`. For a new print job, clear `printEventId`, `printClientJobId`, and `printOccurredAt`. The generated IDs are nonsecret, but avoid sharing a collection export that contains your live workflow state.

## Media and gallery

After selecting a frame and reporting capture, request separate upload slots for the composite JPEG and GIF. For each file, set the matching `byte_size` and lowercase SHA-256 in the intent body, then copy the returned `upload_url` into the local/current value of `uploadUrl`. In **Upload media**, select that exact file as the binary body and set `Content-Type` to its matching MIME type. The upload URL is a short-lived bearer secret. Repeat for the other media type. Report a confirmed print, then finalize. Copy the token from the returned `share_url` into the local/current value of `shareToken` to use the gallery requests.

The collection does not generate media hashes or upload bytes automatically. It does not store passwords, booth credentials, voucher codes, upload URLs or share tokens in the tracked JSON file. Avoid exporting a filled collection or environment with those values.
