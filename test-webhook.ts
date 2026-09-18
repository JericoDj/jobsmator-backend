const url = "https://primary-production-a37f9.up.railway.app/webhook/jobsmator";
const secret = "Godisgoodallthetime";

async function test() {
  console.log("Fetching", url);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-jobsmator-key": secret },
    body: JSON.stringify({
      resume_url: "https://drive.google.com/file/d/18ar9QS3ufmxvsrznsy_K1Ve3GqACsl8J/view?usp=sharing",
      user_id: "test",
      job_interests: ["test"],
      jobsites: ["LinkedIn"],
      jobs_per_site: 10,
      location: "test",
      remote_only: false,
      min_score: 50,
      save_to_sheet: false
    })
  });
  console.log("Status:", res.status);
  console.log("Body:", await res.text());
}
test();
