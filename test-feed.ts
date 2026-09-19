const url = "https://jobsmator-backend-production.up.railway.app/v1/jobs/feed";
async function test() {
  console.log("Fetching", url);
  const res = await fetch(url);
  console.log("Status:", res.status);
  console.log("Body:", await res.text());
}
test();
