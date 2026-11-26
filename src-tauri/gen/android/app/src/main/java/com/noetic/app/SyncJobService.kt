package com.noetic.app

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context

/**
 * Uploads notes the app couldn't upload itself (SPEC 4.1): it runs once the phone is online, even
 * if the app has been closed since. The work is done by the app's own sync code
 * (src-tauri/src/background.rs), which only uses the network when something is waiting.
 *
 * Kept in the repository with MainActivity. `tauri android init` doesn't add services to the
 * manifest, so scripts/patch-android-manifest.mjs registers this one after it runs.
 */
class SyncJobService : JobService() {
  override fun onStartJob(params: JobParameters): Boolean {
    Thread {
      val outcome = try {
        // Already loaded when the app is running; Android may have started the process just for
        // this job.
        System.loadLibrary("noetic_lib")
        uploadWaiting(applicationInfo.dataDir)
      } catch (e: Throwable) {
        RETRY
      }
      jobFinished(params, outcome == RETRY)
    }.start()
    return true
  }

  /** Android stopped the job (the connection went, say): run it again later. */
  override fun onStopJob(params: JobParameters): Boolean = true

  /** 0 when done, 1 to be run again later. */
  private external fun uploadWaiting(dataDir: String): Int

  companion object {
    private const val JOB_ID = 4101
    private const val RETRY = 1
    private const val FIRST_RETRY_MS = 30_000L

    /** Asks for a run once the phone is online. Asking again replaces the earlier request. */
    fun schedule(context: Context) {
      try {
        val scheduler = context.getSystemService(JobScheduler::class.java) ?: return
        val job = JobInfo.Builder(JOB_ID, ComponentName(context, SyncJobService::class.java))
          .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
          .setBackoffCriteria(FIRST_RETRY_MS, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
          .build()
        scheduler.schedule(job)
      } catch (e: Exception) {
        // Without the job, what is waiting is uploaded the next time the app is opened.
      }
    }
  }
}
