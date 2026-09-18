const url = "https://drive.google.com/file/d/18ar9QS3ufmxvsrznsy_K1Ve3GqACsl8J/view?usp=sharing";
const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
if (match) {
  console.log(`https://drive.google.com/uc?export=download&id=${match[1]}`);
}
