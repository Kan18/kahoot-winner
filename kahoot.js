let electron;
if(!process.argv.includes("--disable-electron")){
  electron = require("electron");
}
const compression = require("compression");
const appInformation = require("./package.json");
const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const app = express();
const ip = require("ip");
const http = require("http");
const cookieParser = require("cookie-parser");
const startupDate = Date.now();
const {URL} = require("url");
const {edit} = require("./regex.js");
const request = require("request");
const fs = require("fs");

const DBAmount = 100;
let mainPath = __dirname;
if(electron){
  try{
    mainPath = path.join((electron.app || electron.remote.app).getPath("appData"),"Kahoot Winner");
  }catch(e){
    console.log("Unable to detect application data folder.");
  }
}

if(mainPath != __dirname){
  try{
    fs.mkdirSync(mainPath);
  }catch(e){} // probably already created
}
function sleep(time){
  return new Promise(res=>{
    setTimeout(res,time * 1000);
  });
}

const KahootDatabase = {};
let KahootDatabaseInitialized = false;
if(!fs.existsSync(path.join(mainPath,"latest.txt"))){
  console.log("Generating latest.txt...");
  fs.writeFileSync(path.join(mainPath,"latest.txt"),String(Date.now()));
}
if(!fs.existsSync(path.join(mainPath,"kdb.json")) || Number(fs.readFileSync(path.join(mainPath,"latest.txt"))) + (1000*60*24) < Date.now()){
  console.log("Fetching latest database from archive.org...");
  request("https://archive.org/download/kahoot-win/full-export.json",{json:true},(e,r,b)=>{
    if(e){
      console.log("Error fetching database:");
      console.log(e);
      return;
    }
    console.log("Saving database to kdb.json...");
    for(let i in b){
      const len = b[i].questions.length;
      if(!KahootDatabase[len]){
        KahootDatabase[len] = {
          [i]: b[i]
        };
      }else{
        Object.assign(KahootDatabase[len],{
          [i]: b[i]
        });
      }
    }
    KahootDatabaseInitialized = true;
    fs.writeFile(path.join(mainPath,"latest.txt"),String(Date.now()),()=>{});
    fs.writeFile(path.join(mainPath,"kdb.json"),JSON.stringify(b),()=>{
      console.log("Database loaded.");
    });
  });
}else{
  console.log("Using loaded database");
  fs.readFile(path.join(mainPath,"kdb.json"),"utf8",(err,b)=>{
    if(err){return;}
    KahootDatabaseInitialized = true;
    const data = JSON.parse(b);
    for(let i in data){
      const len = data[i].questions.length;
      if(!KahootDatabase[len]){
        KahootDatabase[len] = {
          [i]: data[i]
        };
      }else{
        Object.assign(KahootDatabase[len],{
          [i]: data[i]
        });
      }
    }
  });
}

app.enable("trust proxy");
app.use(compression({
  filter: (req,res)=>{
    const types = {
      svg: "image/svg+xml",
      js: "text/javascript",
      css: "text/css",
      json: "application/json",
      txt: "text/plain",
      html: "text/html"
    };
    const t = req.url.split(".")[1];
    const a = types[t];
    if(res.statusCode == 404){
      return compression.filter(req,res);
    }
    if(req.url.search(/noop.js/gmi) != -1){
      return compression.filter(req,res);
    }
    if(a){
      res.header("Content-Type",a);
    }
    if(t === undefined){
      res.header("Content-Type","text/html");
    }
    return compression.filter(req,res);
  }
}));
app.use(cookieParser());
app.use((req,res,next)=>{
  if(req.protocol == "https"){
    res.setHeader("Strict-Transport-Security","max-age=31104000");
  }
  res.setHeader("X-XSS-Protection","0");
  next();
});
app.use((req,res,next)=>{
  const origins = ["theusaf.github.io","kahoot.it","play.kahoot.it","create.kahoot.it","code.org","studio.code.org"];
  if(req.get("origin") && origins.includes(req.get("origin").split("://")[1])){
    res.header("Access-Control-Allow-Origin",req.get("origin"));
  }
  next();
});
app.get("/",(req,res,next)=>{
  const cookies = req.cookies;
  const lang = cookies["lang"];
  const langs = ["en","es","zh"];
  if(lang && lang !== "en" && langs.includes(lang)){
    res.redirect("/" + lang);
  }else{
    next();
  }
});
app.use(express.static(path.join(__dirname,"public"),{
  maxAge:"1y",
  setHeaders: (res)=>{
    let d = new Date;
    d.setYear(d.getFullYear() + 1);
    res.setHeader("Expires", d.toUTCString());
  }
}));
app.use(express.static(path.join(__dirname,"locales"),{
  maxAge:"1y",
  setHeaders: (res)=>{
    let d = new Date;
    d.setYear(d.getFullYear() + 1);
    res.setHeader("Expires", d.toUTCString());
  }
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));
const port = process.env.PORT || 2000;
const server = http.createServer(app);
let handshakeVotes = [];
server.once("error",()=>{
  // probably port already in use
  console.log("Port used, assuming kahoot-win already active");
});
server.listen(port);
console.log(ip.address() + ":" + port);
console.log("Using version " + require("./package.json").version);
const ws = require("ws");
const KH = require("kahoot.js-updated");
const Search = require("kahoot-search");
const wss = new ws.Server({server: server});
wss.on("connection",(c,request)=>{
  const a = new Cheater(c,request);
  const msgl = m=>{a.message(m);};
  c.on("message",msgl);
  const cl = ()=>{
    c.removeListener("message",msgl);
    c.removeListener("close",cl);
    if(a.handshakeIssues){
      try {
        a.kahoot.socket.close();
      } catch (e) {
        a.kahoot.leave();
      }
    }else{
      a.kahoot.leave();
    }
    a.finder.hax.stop = true;
    clearMemory(a);
  };
  c.on("close",cl);
});
function clearMemory(c){ // attempt to remove references to reduce memory leaks
  if(!c.finishedProcessing){ // to prevent any crashes, make sure the process is done searching
    setTimeout(()=>{
      clearMemory(c);
    },1000);
    return;
  }
  for(let i in Listeners){
    c.kahoot.removeListener(i,c.kahoot.list[i]);
  }
  c.finder.parent = null;
  c.finder = null;
  c.kahoot.parent = null;
  c.kahoot = null;
  c.wsocket = null;
  clearInterval(c.pinger);
}
function shuffle(array) {
  array = Array.from(array);
  var currentIndex = array.length, temporaryValue, randomIndex;
  // While there remain elements to shuffle...
  while (0 !== currentIndex) {
    // Pick a remaining element...
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex -= 1;
    // And swap it with the current element.
    temporaryValue = array[currentIndex];
    array[currentIndex] = array[randomIndex];
    array[randomIndex] = temporaryValue;
  }
  return array;
}
// Quiz Winner
class Cheater{
  constructor(socket,req){
    // yes, the ip is stored, but only used for maintainance reasons, to prevent spam.
    this.ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress || req.socket.remoteAddress || req.ip || null;
    this.wsocket = socket;
    this.kahoot = new KH;
    this.kahoot.parent = this;
    applyListeners(this.kahoot);
    this.pings = 0;
    this.finder = new QuizFinder;
    this.finder.parent = this;
    this.options = {
      pin: 0,
      fail: false,
      manual: true,
      brute: false,
      timeout: 0,
      searchTerm: "",
      author: "",
      uuid: "",
      hijack: false,
      hijackPassword: "",
      teamMembers: "",
      challengePoints: 0,
      challengeCorrect: false,
      searchLoosely: 0
    };
    this.correctIndex = 0;
    this.fails = [true];
    this.security = {
      joined: false,
      gotQuestion: false
    };
    this.pinger = setInterval(()=>{
      this.send({message:"ping",type:"Message.Ping"});
    },30*1000);
    this.send({"type":"Message.OK","message":"200 OK"});
  }
  isOffline(){
    try{
      return this.wsocket.readyState == 3;
    }catch(e){
      return true;
    }
  }
  close(){
    if(this.isOffline()){
      return;
    }
    this.wsocket.close();
  }
  send(message){
    if(this.isOffline()){
      return;
    }
    if(typeof(message) != "string"){
      try{message = JSON.stringify(message);}catch(err){message=message + "";}
    }
    this.wsocket.send(message);
  }
  message(message){
    let data;
    try{data = JSON.parse(message);}catch(err){return this.send({message:"INVALID_USER_INPUT",type:"Error"});}
    if(typeof(data.type) == "undefined" || typeof(Messages[data.type]) == "undefined" || typeof(data.message) == "undefined"){
      this.send({message:"INVALID_USER_INPUT",type:"Error"});
      return;
    }
    Messages[data.type](this,data.message);
  }
  generateRandomName(){
    return new Promise(res=>{
      request("https://apis.kahoot.it/namerator",(e,r,b)=>{
        try{
          res(JSON.parse(b).name);
        }catch(e){
          res("BadHtml");
        }
      });
    });
  }
}
class QuizFinder{
  constructor(){
    this.cursor = 0;
    this.ignoreDB = false;
    this.DBIndex = 0;
    this.ignoreKahoot = false;
    this.hax = {
      validOptions: [],
      answers: [],
      correctAnswer: 0,
      cursor: 0,
      stop: false
    };
  }
  getAnswers(q,log){
    var me = this;
    try{
      let ans;
      switch (q.gameBlockType) {
      case "open_ended":
      case "word_cloud":
        ans = "honestly, i don't know";
        break;
      case "jumble":
        ans = shuffle([0,1,2,3]);
        break;
      case "multiple_select_quiz":
        ans = shuffle([0,1,2,3]).slice((q.quizQuestionAnswers || this.parent.kahoot.quiz.quizQuestionAnswers)[q.questionIndex] - Math.floor(Math.random() * (this.parent.kahoot.quiz.quizQuestionAnswers[q.questionIndex] + 1)));
        break;
      default:
        ans = Math.floor(Math.random() * (q.quizQuestionAnswers || this.parent.kahoot.quiz.quizQuestionAnswers)[q.questionIndex]);
      } // default values
      this.hax.correctAnswer = ans;
      if(log){console.log(`Using quiz id ${me.hax.validOptions[0].uuid}`);}
      const choices = me.hax.validOptions[0].questions[q.questionIndex].choices;
      if(!choices){
        return [{correct: false,ans:""},{correct: false,ans:""},{correct: false,ans:""},{correct: false,ans:""}];
      }
      if(this.hax.validOptions[0].questions[q.questionIndex].type != q.gameBlockType){
        return this.hax.validOptions[0].questions[q.questionIndex].choices || [{correct: false,ans:""},{correct: false,ans:""},{correct: false,ans:""},{correct: false,ans:""}];
      }
      for(let i = 0;i<choices.length;++i){
        if(choices[i].correct){
          me.hax.correctAnswer = i;
          // open ended support
          if(me.hax.validOptions[0].questions[q.questionIndex].type == "open_ended"){
            me.hax.correctAnswer = choices[i].answer;
          }
          break;
        }
      }
      // jumble support
      if(me.hax.validOptions[0].questions[q.questionIndex].type == "jumble"){
        // since we cannot actually find out the correct answer as this is a program, we just guess...
        me.hax.correctAnswer = shuffle([0,1,2,3]);
        // if challenge
        if(this.parent.options.isChallenge){
          this.hax.correctAnswer = [0,1,2,3];
        }
      }
      // multiple_select_quiz support
      if(this.hax.validOptions[0].questions[q.questionIndex].type == "multiple_select_quiz"){
        const choices = this.hax.validOptions[0].questions[q.questionIndex].choices || [];
        let ok = [];
        for(let i = 0;i<choices.length;i++){
          if(choices[i].correct){
            ok.push(i);
          }
        }
        this.hax.correctAnswer = ok;
      }
      return me.hax.validOptions[0].questions[q.questionIndex].choices;
    }catch(err){
      return [{correct: false,ans:""},{correct: false,ans:""},{correct: false,ans:""},{correct: false,ans:""}];
    }
  }
  // todo: improve loose search to include question type when searching
  async searchKahoot(index){
    // no need to search for challenges
    if(!this.parent){
      return;
    }
    if(this.parent.options.isChallenge){
      return;
    }
    if(this.hax.stop){
      this.parent.finishedProcessing = true;
      return; // stop searching! the quiz ended or the user is disconnected!
    }
    // these filters are to filter out quizzes based on new answers
    const filter = o=>{
      if(o.questions.length != this.parent.kahoot.quiz.quizQuestionAnswers.length){
        return false;
      }
      let a = this.hax.answers;
      for(var i = 0;i < a.length;++i){
        try{
          if(o.questions[a[i].i].type != a[i].t){
            return false;
          }
          if(!o.questions[a[i].i].choices){
            // if no choices ignore, unless a[i] actually was something
            if(a[i].n){
              return false;
            }
            continue;
          }
          if(o.questions[a[i].i].type == "jumble" || o.questions[a[i].i].choices.filter(
            k=>{
              if(typeof k.answer == "undefined"){
                return k.correct && (a[i].n == "");
              }
              return k.correct && (k.answer == a[i].n);
            }).length
          ){
            continue;
          }else{
            // an answer did not match!
            return false;
          }
        }catch(err){
          // we log stuff, but assume the worst, so we continue looping.
          // UPDATE: no longer logging stuff, we just return false.
          return false;
        }
      }
      return true;
    };
    const filter2 = o=>{
      let a = this.hax.answers;
      for(var i = 0;i < a.length;++i){
        try{
          for(let question of o.questions){
            // TODO: Add jumble and multi select support
            if(!question.choices){
              continue;
            }
            if(question.type == "jumble"){
              return true;
            }
            if(question.choices.filter(c=>{
              if(typeof c.answer == "undefined"){
                return c.correct && (a[i].n == "");
              }
              return c.correct && a[i].n == c.answer;
            }).length){
              return true;
            }
          }
          return false;
        }catch(err){
          // we log stuff, but assume the worst, so we continue looping.
          // UPDATE: no longer logging stuff, we just return false.
          return false;
        }
      }
      return true;
    };
    let use = +this.parent.options.searchLoosely ? filter2 : filter;
    if(this.hax.validOptions.filter(use).length){
      this.hax.validOptions = this.hax.validOptions.filter(use);
      console.log("Possible quiz found");
      return;
    }else{
      this.hax.validOptions = [];
    }
    let options = {
      cursor: this.hax.cursor,
      limit: 25,
      type: ["quiz"],
      includeCard: false,
      searchStrictly: false
    };
    if(this.parent.options.author){
      options.author = this.parent.options.author;
    }
    if(!this.parent.options.uuid){
      const searchText = (this.parent.options.searchTerm ? edit(this.parent.options.searchTerm) : "");
      const len = this.parent.kahoot.quiz.quizQuestionAnswers.length;
      if((searchText.replace(/\s\*/g,"")) == ""){
        if(!this.hax.noQuiz){
          this.hax.noQuiz = true;
          this.parent.send({
            type: "Error",
            message: "EMPTY_NAME"
          });
        }
        let results = (!this.ignoreDB && SearchDatabase(this,this.DBIndex)) || [];
        this.DBIndex += DBAmount || 50;
        if(!this.parent){
          this.hax.stop = true;
          return;
        }
        if(this.parent.kahoot.quiz.currentQuestion && index < this.parent.kahoot.quiz.currentQuestion.questionIndex + 1){
          this.hax.validOptions = results;
          return;
        }
        if(results.length){
          this.hax.validOptions = results || [];
          return console.log("Setting results from database");
        }
        if(!KahootDatabase[len] || this.DBIndex >= Object.keys(KahootDatabase[len]).length){
          this.ignoreDB = true;
        }else{
          await sleep(0.1);
          console.log("Researching");
          this.searchKahoot(index);
        }
        return console.log("No quiz specified.");
      }
      console.log(searchText);
      let results = (!this.ignoreKahoot && await Searching(searchText,options,this)) || [];
      let results2 = (!this.ignoreDB && SearchDatabase(this,this.DBIndex)) || [];
      if(!this.parent){
        this.hax.stop = true;
        return;
      }
      // Limit searches to 7500 (300 total searches / quiz)
      if(typeof results.totalHits == "number"){
        this.hax.totalHits = results.totalHits;
      }
      if(this.hax.cursor >= 7500 || (this.hax.totalHits < this.hax.cursor)){
        this.ignoreKahoot = true;
        if(this.ignoreDB){
          this.hax.stop = true;
        }
      }
      delete results.totalHits;
      this.hax.cursor += 25;
      if(!this.parent){
        this.hax.stop = true;
        return;
      }
      if(this.parent.kahoot.quiz.currentQuestion && index < this.parent.kahoot.quiz.currentQuestion.questionIndex + 1){
        this.hax.validOptions = results || results2 || [];
        return;
      }
      if(results.length == 0){
        this.DBIndex += DBAmount || 50;
        if(results2.length !== 0){
          console.log("Setting results from database");
          this.hax.validOptions = results2 || [];
          return;
        }
        if(!KahootDatabase[len] || this.DBIndex >= Object.keys(KahootDatabase[len]).length){
          this.ignoreDB = true;
          return;
        }
        await sleep(0.1);
        console.log("Researching");
        this.searchKahoot(index);
      }else{
        console.log("Setting results");
        this.hax.validOptions = results || [];
        return;
      }
    }else{
      //console.log("uuid specified");
      request(`https://create.kahoot.it/rest/kahoots/${this.parent.options.uuid}`,(e,r,b)=>{
        let data;
        try{
          data = JSON.parse(b);
        }catch(e){
          this.parent.options.uuid = "";
          return this.searchKahoot(index);
        }
        if(data.error){
          this.parent.options.uuid = "";
          return this.searchKahoot(index);
        }
        this.hax.validOptions = [data];
      });
    }
  }
}
function SaveItem(){}
function WebhookMessage(){SaveItem();}
function SearchDatabase(finder,index){
  if(!KahootDatabaseInitialized){
    return [];
  }
  if(!finder.parent){
    return [];
  }
  const filt = k=>{
    if(!finder.parent){
      return false;
    }
    if(finder.parent.options.author){
      if(finder.parent.options.author != k.author){
        return false;
      }
    }
    let ans = finder.hax.answers;
    if(+finder.parent.options.searchLoosely){
      const a = k.answerMap.slice().sort();
      const b = finder.parent.kahoot.quiz.quizQuestionAnswers.slice().sort();
      if(JSON.stringify(a) !== JSON.stringify(b)){
        return false;
      }
      if(ans.length){
        for (let i = 0; i < ans.length; i++) {
          let ok = false;
          for (let j = 0; j<k.questions.length;j++) {
            if(!k.questions[j].choices){
              continue;
            }
            if(k.questions[j].choices.filter(choice=>{
              return choice.answer == ans[i].n;
            }).length){
              ok = true;
              break;
            }
          }
          if(!ok){
            return false;
          }
        }
      }
    }else{
      const a = k.answerMap;
      const b = finder.parent.kahoot.quiz.quizQuestionAnswers;
      if(JSON.stringify(a) !== JSON.stringify(b)){
        return false;
      }
      if(ans.length){
        for (let i = 0; i < ans.length; i++) {
          let ok = false;
          if(!k.questions[i].choices){
            if(a[i].n){
              return false;
            }
            continue;
          }
          if(k.questions[i].type != a[i].t){
            return false;
          }
          const ch = k.questions[ans[i].i].choices;
          for (let j = 0; j < ch.length; j++) {
            if(ch[j].answer == ans[i].n){
              ok = true;
              break;
            }
          }
          if(!ok){
            return false;
          }
        }
      }
    }
    return true;
  };
  const len = finder.parent.kahoot.quiz.quizQuestionAnswers.length;
  if(!KahootDatabase[len]){
    return [];
  }
  let res = [];
  const keys = Object.keys(KahootDatabase[len]);
  try{
    for(let i = index || 0;i< index + (DBAmount || 50);i++){
      const item = KahootDatabase[len][keys[i]];
      if(filt(item)){
        res.push(item);
      }
    }
  }catch(e){return res;}
  return res;
}
async function Searching(term,opts,finder){
  const a = new Search(term,opts);
  try{
    return await a.search(o=>{
      o = o.kahoot;
      if(!finder.parent){
        return false;
      }
      if(!finder.parent.kahoot.quiz){
        return true;
      }
      const mainFilter = ()=>{
        let a = finder.hax.answers;
        let b = false;
        if(!finder.hax.answers.length){
          b = true;
        }
        for(var i = 0;i < a.length;++i){
          if(!o.questions[a[i].i].choices){
            continue;
          }
          if(a[i].t != o.questions[a[i].i].type){
            break;
          }
          // if correct answer matches or is a survey/jumble/info
          if(o.questions[a[i].i].choices.filter(
            k=>{
              return (
                (k.correct && (k.answer == a[i].n)) || (k.correct && (((typeof k.answer == "undefined") ? "" : k.answer) == a[i].n))
              ) || o.type == "survey" || o.type == "multiple_select_poll" || o.type == "word_cloud" || o.type == "content" || (o.type == "jumble" /* TODO: Add Extra checks for JUMBLES and multi select*/ );
            }
          ).length){
            b = true;
          }
        }
        return b;
      };
      const mainFilter2 = ()=>{
        let correct = true;
        for(let i = 0;i<o.questions.length;++i){
          // "content" support
          if(!o.questions[i].choices){
            continue;
          }
          if(o.questions[i].choices.length != finder.parent.kahoot.quiz.quizQuestionAnswers[i]){
            correct = false;
          }
        }
        return correct;
      };
      const looseFilter = ()=>{
        let a = finder.hax.answers;
        let b = false;
        if(!finder.hax.answers.length){
          b = true;
        }
        for(var i = 0;i < a.length;++i){
          try{
            for(let question of o.questions){
              if(!question.choices){
                continue;
              }
              if(question.choices.filter(k=>{
                return (
                  (k.correct && (k.answer == a[i].n)) || (k.correct && (((typeof k.answer == "undefined") ? "" : k.answer) == a[i].n))
                ) || o.type == "survey" || o.type == "multiple_select_poll" || o.type == "word_cloud" || o.type == "content" || (o.type == "jumble" /* TODO: Add Extra checks for JUMBLES*/ );
              }).length){
                b = true;
              }
            }
          }catch(e){
            b = false;
            break;
          }
        }
        return b;
      };
      const looseFilter2 = ()=>{
        let qc = [];
        for(let i = 0;i<o.questions.length;++i){
          // "content" support
          if(!o.questions[i].choices){
            qc.push(null);
            continue;
          }
          qc.push(o.questions[i].choices.length);
        }
        qc.sort();
        qc = JSON.stringify(qc);
        const qca = JSON.stringify(finder.parent.kahoot.quiz.quizQuestionAnswers.slice(0).sort());
        if(qc == qca){
          return true;
        }
        return false;
      };
      let filter = mainFilter;
      let filter2 = mainFilter2;
      if(+finder.parent.options.searchLoosely){
        filter = looseFilter;
        filter2 = looseFilter2;
      }
      return (finder.parent.options.author ? o.creator_username == finder.parent.options.author : true)
      && (o.questions.length == finder.parent.kahoot.quiz.quizQuestionAnswers.length)
      && filter() && filter2();
    });
  }catch(err){
    return [];
  }
}
const Messages = {
  SET_PIN: (game,pin)=>{
    try{
      const url = new URL(pin);
      const path = url.pathname.split(/challenge\//g)[1];
      // if it was an invalid link, this should throw an error
      let isPin = path.match(/\d+/g)[0];
      if(path.length == isPin.length && path.length > 0){
        // this means that the pin is in the link lol
        pin = path;
      }else{
        request(`https://kahoot.it/rest/challenges/${path}`,(e,r,b)=>{
          try{
            b = JSON.parse(b);
            if(b.pin){
              pin = b.pin;
              request(`https://kahoot.it/rest/challenges/pin/${pin}`,(e,r,b)=>{
                if(/NOT_FOUND/img.test(b)){
                  game.send({message:"INVALID_PIN",type:"Error"});
                }else{
                  game.send({message:`Connected to ${pin}!`,type:"Message.PinGood"});
                  game.options.pin = pin;
                  game.options.isChallenge = true;
                  try{game.finder.hax.validOptions = [JSON.parse(b).kahoot];}catch(e){game.finder.hax.validOptions = [];}
                }
              });
            }else{
              game.send({message:"INVALID_PIN",type:"Error"});
            }
          }catch(e){
            game.send({message:"INVALID_PIN",type:"Error"});
          }
        });
        return;
      }
    }catch(err){}
    // weekly kahoot support
    if(["weekly","weekly-previous","https://kahoot.com/kahoot-of-the-week-previous","https://kahoot.com/kahoot-of-the-week","https://kahoot.com/kahoot-of-the-week-previous/","https://kahoot.com/kahoot-of-the-week-previous","kahoot-of-the-week","kahoot-of-the-week-previous"].includes(pin)){
      let url;
      if(pin.indexOf("previous") != -1){ // previous
        url = "https://kahoot.com/kahoot-of-the-week-previous";
      }else{ // current
        url = "https://kahoot.com/kahoot-of-the-week";
      }
      request(url,(e,r,b)=>{
        try{
          const p = b.match(/(?<=challenge\/)\d+/gm)[0];
          game.send({message:`Connected to ${p}!`,type:"Message.PinGood"});
          game.options.pin = p;
          game.options.isChallenge = true;
          try{game.finder.hax.validOptions = [JSON.parse(b).kahoot];}catch(e){game.finder.hax.validOptions = [];}
        }catch(err){
          game.send({message:"INVALID_PIN",type:"Error"});
        }
      });
      return;
    }
    if(pin && pin[0] == "0"){
      request(`https://kahoot.it/rest/challenges/pin/${pin}`,(e,r,b)=>{
        if(/NOT_FOUND/img.test(b)){
          game.send({message:"INVALID_PIN",type:"Error"});
        }else{
          game.send({message:`Connected to ${pin}!`,type:"Message.PinGood"});
          game.options.pin = pin;
          game.options.isChallenge = true;
          try{game.finder.hax.validOptions = [JSON.parse(b).kahoot];}catch(e){game.finder.hax.validOptions = [];}
        }
      });
      return;
    }
    request(`https://kahoot.it/reserve/session/${pin}/?${Date.now()}`,(e,r,b)=>{
      if(b == "Not found" || /(MethodNotAllowedError)/img.test(b)){
        game.send({message:"INVALID_PIN",type:"Error"});
      }else{
        game.send({message:`Connected to ${pin}!`,type:"Message.PinGood"});
        game.options.pin = Number(pin);
      }
    });
  },
  SET_OPTS: (game,opts)=>{
    try{
      const old = Object.assign({},game.options);
      opts.searchLoosely = Number(opts.searchLoosely);
      Object.assign(game.options,JSON.parse(opts));
      // if these changed, reset cursor.
      if(old.searchLoosely != game.options.searchLoosely || old.author != game.options.author || old.searchTerm != game.options.searchTerm){
        game.finder.hax.cursor = 0;
        game.finder.hax.noQuiz = false;
        game.finder.hax.stop = false;
        game.finder.ignoreKahoot = false;
      }
      // variable answer
      if(Number(game.options.timeout) < 0){
        game.options.timeout = Math.abs(game.options.timeout);
        game.options.variableTimeout = true;
      }else{
        game.options.variableTimeout = false;
      }
      // disable autoplay
      if(game.options.ChallengeDisableAutoplay){
        game.kahoot.defaults.options.ChallengeAutoContinue = false;
      }else{
        game.kahoot.defaults.options.ChallengeAutoContinue = true;
      }
      if(game.options.challengePoints){
        game.kahoot.defaults.options.ChallengeScore = +game.options.challengePoints;
      }else{
        game.kahoot.defaults.options.ChallengeScore = 0;
      }
      if(game.options.challengeCorrect){
        game.kahoot.defaults.options.ChallengeAlwaysCorrect = true;
      }else{
        game.kahoot.defaults.options.ChallengeAlwaysCorrect = false;
      }
      if(game.options.ChallengeEnableStreaks){
        game.kahoot.defaults.options.ChallengeUseStreakBonus = true;
      }else{
        game.kahoot.defaults.options.ChallengeUseStreakBonus = false;
      }
      // remove default fail.
      if((game.options.fail == 2 && game.fails.length == 1) || game.options.fail != old.fail){
        if(game.options.fail == 2){
          game.fails = [false];
        }else{
          game.fails = [true];
        }
      }
      // timeframe
      if(isNaN(game.options.timeout)){
        try { // assume [-]d[s]-[s][-]d
          let args = game.options.timeout.split("-");
          if(args.length === 2){
            game.options.timeout = Number(args[0]);
            game.options.timeoutEnd = Number(args[1]);
          }else if(args.length === 3){
            game.options.timeout = -Number(args[1]);
            game.options.timeoutEnd = Number(args[2]);
          }else{ // assume 4
            game.options.timeout = -Number(args[1]);
            game.options.timeoutEnd = Number(args[3]);
          }
          game.options.timeout = game.options.timeout || 0;
        } catch (e) {
          game.options.timeout = 0;
          game.options.timeoutEnd = 0;
        }
      }

      // changing timeout mid question.
      if(old.timeout != game.options.timeout){
        if(game.security.joined && game.security.gotQuestion && game.questionReady === true && !game.options.manual){
          clearTimeout(game.waiter);
          const start = game.options.timeout * 1000 + (Number(game.options.variableTimeout) * Math.random() * 1000);
          const end = Math.random() * ((Number(game.options.timeoutEnd) - (start/1000) || 0)) * 1000;
          const delayed = Date.now() - game.security.receivedTime;
          game.waiter = setTimeout(()=>{
            if(!game.kahoot){return;}
            QuestionAnswer(game.kahoot,game.kahoot.quiz.currentQuestion);
          },start+end-delayed);
        }
      }
    }catch(err){
      game.send({message:"INVALID_USER_INPUT",type:"Error"});
    }
  },
  JOIN_GAME: (game,name)=>{
    if(game.security.joined){
      game.send({message:"INVALID_NAME",type:"Error"});
      return;
    }
    game.security.joined = true;
    if(name == "de_se_me"){
      game.kahoot.loggingMode = true;
    }
    game.kahoot.join(game.options.pin,(name||"") + "",game.options.teamMembers ? game.options.teamMembers.toString().split(",") : undefined).catch(err=>{
      if(err && err.error && err.error.includes("handshake_denied")){
        handshakeVotes.push(game.ip);
      }
      game.send({message:"INVALID_NAME",type:"Error",data:err});
    });
  },
  ANSWER_QUESTION: (game,answer)=>{
    if(!game.security.joined || !game.kahoot.quiz || !game.kahoot.quiz.currentQuestion){
      return;
    }
    if((typeof (answer) == "undefined") || answer === ""){
      game.send({message:"INVALID_USER_INPUT",type:"Error"});
      game.kahoot.answer(game.finder.hax.correctAnswer).then(()=>{
        QuestionSubmit(game.kahoot);
      }).catch(()=>{});
      return;
    }else if(answer === null){
      return QuestionAnswer(game.kahoot,game.kahoot.quiz.currentQuestion);
    }
    game.kahoot.answer(answer).then(()=>{
      QuestionSubmit(game.kahoot);
    }).catch(()=>{});
  },
  CHOOSE_QUESTION_INDEX: (game,index)=>{
    index = Number(index);
    if(!game.security.joined || !game.kahoot.quiz.currentQuestion || game.finder.hax.validOptions.length == 0 || game.finder.hax.validOptions[0].questions.length <= index || index < 0){
      return game.send({message:"INVALID_USER_INPUT",type:"Error"});
    }
    if(index != game.correctIndex){
      game.correctIndex = index;
      const type2 = game.kahoot.quiz.currentQuestion.type;
      const type = game.finder.hax.validOptions[0].questions[index].gameBlockType;
      if(type != type2){ // hmm, wrong question.
        return;
      }
      const choices = game.finder.hax.validOptions[0].questions[index].choices;
      if(!choices){
        return;
      }
      try{ // just in case
        for(let i = 0;i<choices.length;++i){
          if(choices[i].correct){
            game.finder.hax.correctAnswer = i;
            // open ended support
            if(game.finder.hax.validOptions[0].questions[index].type == "open_ended"){
              game.finder.hax.correctAnswer = choices[i].answer;
            }
            break;
          }
        }
        // jumble support
        if(game.finder.hax.validOptions[0].questions[index].type == "jumble"){
          // since we cannot actually find out the correct answer as this is a program, we just guess...
          game.finder.hax.correctAnswer = shuffle([0,1,2,3]);
          // if challenge
          if(game.options.isChallenge){
            game.finder.hax.correctAnswer = [0,1,2,3];
          }
        }
        // multiple_select_quiz support
        if(game.finder.hax.validOptions[0].questions[index].type == "multiple_select_quiz"){
          const choices = game.finder.hax.validOptions[0].questions[index].choices || [];
          let ok = [];
          for(let i = 0;i<choices.length;i++){
            if(choices[i].correct){
              ok.push(i);
            }
          }
          game.finder.hax.correctAnswer = ok;
        }
      }catch(e){}
    }
  },
  DO_TWO_STEP: async (game,steps)=>{
    if(!game.security.joined){
      return game.send({message:"SESSION_NOT_CONNECTED",type:"Error"});
    }
    try{await game.kahoot.answerTwoFactorAuth(JSON.parse(steps));}catch(err){game.send({message:"INVALID_USER_INPUT",type:"Error"});}
  },
  GET_RANDOM_NAME: game=>{
    game.generateRandomName().then(name=>{
      game.send({message:name,type:"Message.SetName"});
    });
  },
  NEXT_CHALLENGE: game=>{
    // security
    if(!game.options.isChallenge || !game.security.joined || game.kahoot.data.phase == "leaderboard"){
      return game.send({message:"SESSION_NOT_CONNECTED",type:"Error"});
    }
    try{
      game.kahoot.next();
    }catch(e){
      console.log("Caught CHALLENGE ERROR:");
      console.log(e);
    }
  },
  FAIL_CURRENT_QUESTION: (game,choice)=>{
    if(!game.security.joined || !game.kahoot.quiz || !game.kahoot.quiz.currentQuestion){
      return game.send({message:"SESSION_NOT_CONNECTED",type:"Error"});
    }
    game.fails[game.kahoot.quiz.currentQuestion.questionIndex] = Boolean(choice);
    game.send({message:Boolean(choice).toString(),type:"Message.Ping"});
  },
  RECOVER_DATA: (game,message)=>{
    // message should be an object containing quiz name, answers, etc.
    // base validation. Does not work on challenges
    if(game.security.joined || !game.options.pin || game.options.pin[0] == "0" || !message || !message.cid){
      return game.send({message:"INVALID_USER_INPUT",type:"Error"});
    }
    // answers validation
    if(message.answers){
      if(!Array.isArray(message.answers)){
        return game.send({message:"INVALID_USER_INPUT",type:"Error"});
      }
      if(message.answers.length > 100){ // probably BS. closing to reduce memory usage
        return game.send({message:"INVALID_USER_INPUT",type:"Error"});
      }
      for (var i = 0; i < message.answers.length; i++) {
        const ans = message.answers[i];
        // answers are like {i:0,n:"foobar",t:"quiz",c:false,ns:[]}
        if(typeof ans.i == "undefined" || ans.i == null || !(ans.n && typeof ans.n == "string") || !(ans.t && typeof ans.t == "string") || typeof ans.c == "undefined" || (typeof ans.ns == "undefined" || !Array.isArray(ans.ns))){
          return game.send({message:"INVALID_USER_INPUT",type:"Error"});
        }
      }
      game.finder.answers = message.answers;
    }
    // updating information
    game.kahoot.cid = message.cid;
    game.kahoot.gameid = game.options.pin;
    game.kahoot.socket = {
      readyState: 3,
      close: ()=>{}
    };
    game.kahoot.reconnect().catch(()=>{
      game.send({message:"SESSION_NOT_CONNECTED",type:"Error"});
    });
  },
  HANDSHAKE_ISSUES: (game,message)=>{
    if(message != "AAAA!"){
      return;
    }
    if(game.handshakeIssues && game.ip && !(handshakeVotes.includes(game.ip))){
      const message = "A handshake error was reported at " + (new Date()).toString();
      console.log(message);
      WebhookMessage(message,"Kashoot!");
      handshakeVotes.push(game.ip);
    }else{ // liar
      game.send({
        type: "Error",
        message: "INVALID_USER_INPUT"
      });
    }
  },
  SEND_FEEDBACK: async (game,message)=>{
    if(!game.security.joined){game.send({message:"INVALID_USER_INPUT",type:"Error"});}
    try{
      const {fun,learn,recommend,overall} = message;
      game.kahoot.sendFeedback(fun,learn,recommend,overall);
    }catch(e){
      console.log(e);
      game.send({message:"INVALID_USER_INPUT",type:"Error"});
    }
  }
};
const QuestionSubmit = (k)=>{
  const snark = ["Were you tooooooo fast?","Pure genius or guesswork?","Secret classroom superpowers?","Genius machine?","Classroom perfection?","Pure genius?","Lightning smart?"];
  k.parent.send({message:snark[Math.floor(Math.random() * snark.length)],type:"Message.QuestionSubmit"});
};
const QuestionAnswer = async (k,q)=>{
  if(!q){
    return;
  }
  if(!k.parent){ // prevent more crashes...
    return;
  }
  let answer = k.parent.finder.hax.correctAnswer;
  if(Number(k.parent.options.fail) && k.parent.fails[q.questionIndex]){
    switch (q.gameBlockType) {
    case "open_ended":
    case "word_cloud":
      answer = "fgwadsfihwksdxfs";
      break;
    case "jumble":
      answer = [-1,0,1,2];
      break;
    case "multiple_select_poll":
    case "multiple_select_quiz":
      answer = [-1];
      break;
    default:
      answer = -1;
    }
  }
  k.parent.teamAnswered = true;
  if(k.parent.options.teamtalk){
    const diff = Date.now() - k.parent.teamTalkTime;
    if(diff < 250){await sleep((250 - diff)/1000);}
  }
  k.answer(answer).then(()=>{
    QuestionSubmit(k);
  }).catch(()=>{});
};
const Listeners = {
  Joined: k=>{
    k.parent.security.joined = true;
    k.parent.send({message:JSON.stringify({
      name: k.name,
      cid: k.cid
    }),type:"Message.JoinSuccess"});
  },
  QuizStart: (k,q)=>{
    if(k.parent.options.isChallenge){
      // set valid options
      if(!k.parent.finder.hax.validOptions.length){
        k.parent.finder.hax.validOptions.push(q.rawEvent);
      }
    }
    if(typeof(q.type) == "undefined"){
      q.type = "quiz"; // Since we joined in the middle of things, we have to assume a quiz type
      q.name = ""; // Set blank name, since we also won't know that.
    }
    k.parent.finder.hax.cursor = 0;
    q.name = k.parent.options.name && !q.name ? k.parent.options.name : q.name;
    k.parent.send({
      message:JSON.stringify({name:q.name,raw:q}),
      type: "Message.QuizStart"
    });
    k.parent.finder.searchKahoot(0);
  },
  QuestionReady: (k,q)=>{
    k.parent.questionReady = true;
    if(k.parent.fails.length === 1){
      for(let i = 0;i<k.quiz.quizQuestionAnswers.length - 1;i++){
        if(Number(k.parent.options.fail) == 0){
          break;
        }
        k.parent.fails.push(Math.random() > (Number(k.parent.options.fail)) ? true : false);
      }
      k.parent.fails = shuffle(k.parent.fails);
    }
    k.parent.send({message:JSON.stringify({data:k.parent.finder.getAnswers(q,true),index:q.questionIndex,total:k.quiz.quizQuestionAnswers.length,ans:k.quiz.quizQuestionAnswers,currentGuesses:k.parent.finder.hax.validOptions,type:q.type,raw:q,timeLeft:q.timeLeft,cans:k.parent.finder.hax.answers}),type:"Message.QuestionGet"});
  },
  QuestionStart: (k,q)=>{
    if(k.parent.questionReady === false){
      return; // question already ended?
    }
    k.parent.security.gotQuestion = true;
    k.parent.security.receivedTime = Date.now();
    if(k.parent.options.manual || k.parent.teamAnswered || Number(k.parent.options.searchLoosely) == 2){
      k.parent.send({message:JSON.stringify({
        data: k.parent.finder.getAnswers(q),
        index: q.questionIndex,
        total: k.quiz.quizQuestionAnswers.length,
        ans: q.quizQuestionAnswers,
        currentGuesses: k.parent.finder.hax.validOptions,
        type: q.gameBlockType,
        raw: q,
        cans: k.parent.finder.hax.answers
      }),type:"Message.QuestionBegin"});
    }else{
      k.parent.send({message:JSON.stringify({
        data: k.parent.finder.getAnswers(q),
        index: q.questionIndex,
        total: k.quiz.quizQuestionAnswers.length,
        ans: q.quizQuestionAnswers,
        currentGuesses: k.parent.finder.hax.validOptions,
        type: q.gameBlockType,
        raw: q,
        cans: k.parent.finder.hax.answers
      }),type:"Message.QuestionBegin"});
      const start = k.parent.options.timeout * 1000 + (Number(k.parent.options.variableTimeout) * Math.random() * 1000);
      const end = Math.random() * ((Number(k.parent.options.timeoutEnd) - (start/1000) || 0)) * 1000;
      k.parent.waiter = setTimeout(()=>{
        QuestionAnswer(k,q);
      },start + end);
    }
  },
  QuestionEnd: (k,q)=>{
    k.parent.questionReady = false;
    clearTimeout(k.parent.waiter);
    k.parent.teamAnswered = false;
    k.parent.send({message:JSON.stringify(Object.assign({
      raw: q,
      data: k.parent.finder.getAnswers(Object.assign({
        questionIndex: (k.quiz.currentQuestion || {}).questionIndex,
        gameBlockType: (k.quiz.currentQuestion || {}).gameBlockType
      },q)),
      index: (k.quiz.currentQuestion || {}).questionIndex,
      total: k.quiz.quizQuestionAnswers.length,
      ans: k.quiz.quizQuestionAnswers,
      currentGuesses: k.parent.finder.hax.validOptions,
      type: (k.quiz.currentQuestion || {}).gameBlockType,
      cans: k.parent.finder.hax.answers
    },q)),type:"Message.QuestionEnd"});
    if(!k.parent.security.gotQuestion){
      return;
    }
    k.parent.security.gotQuestion = false;
    try{
      k.parent.finder.hax.answers.push({t:k.quiz.currentQuestion.gameBlockType,ns:q.correctAnswers,n:q.correctAnswers[0],c:q.isCorrect,i:k.quiz.currentQuestion.questionIndex});
      k.parent.finder.searchKahoot(k.quiz.currentQuestion.questionIndex + 1);
    }catch(err){
      // likely due to joining in the middle of the game
    }
  },
  QuizEnd: (k,q)=>{
    k.parent.send({message:JSON.stringify(q),type:"Message.QuizFinish"});
    k.parent.finder.hax.stop = true;
    if(k.parent.options.isChallenge){
      k.defaults.options.ChallengeAutoContinue = false;
      setTimeout(()=>{
        try{
          k.next();
        }catch(err){
          console.log("Caught CHALLENGE ERROR:");
          console.log(err);
        }
      },1000 * 60 * 2);
      return;
    }
  },
  Podium: (k,t)=>{
    k.parent.send({message:JSON.stringify(t),type:"Message.FinishText"});
  },
  Disconnect: (k,r)=>{
    k.parent.send({message:r,type:"Message.QuizEnd"});
    k.parent.finder.hax.stop = true;
    k.parent.security.joined = false;
    k.parent.finishedProcessing = true;
  },
  TwoFactorReset: k=>{
    if(k.parent.options.brute){
      clearInterval(k.bruter);
      let i = 0;
      k.bruter = setInterval(()=>{
        k.answerTwoFactorAuth(BruteForces[i++]).catch(()=>{});
        if(!BruteForces[i]){
          clearInterval(k.bruter);
        }
      },280);
    }else{
      k.parent.send({message:"Two Step Auth Required",type:"Message.RunTwoSteps"});
    }
  },
  TwoFactorCorrect: k=>{
    clearInterval(k.bruter);
    k.parent.send({message:"Two Step Auth Completed",type:"Message.TwoStepSuccess"});
  },
  TwoFactorWrong: k=>{
    if(!k.parent.options.brute){
      k.parent.send({message:"Failed Two Step Auth",type:"Message.FailTwoStep"});
    }
  },
  Feedback: k=>{
    k.parent.send({message:"Feedback!",type:"Message.Feedback"});
  },
  HandshakeFailed: k=>{
    console.log("Handshake failure occured.");
    k.parent.handshakeIssues = true;
    k.parent.security.joined = false;
    k.parent.send({message:"HANDSHAKE",type:"Error"});
  },
  TimeOver: (k,inf)=>{
    k.parent.send({message:JSON.stringify(inf),type:"Message.TimeOver"});
  },
  TeamTalk: (k,q)=>{
    k.parent.teamTalkTime = Date.now();
    k.parent.security.gotQuestion = true;
    k.parent.send({message:JSON.stringify({
      data: k.parent.finder.getAnswers(q),
      index: q.questionIndex,
      total: k.quiz.quizQuestionAnswers.length,
      ans: q.quizQuestionAnswers,
      currentGuesses: k.parent.finder.hax.validOptions,
      type: q.gameBlockType,
      raw: q,
      cans: k.parent.finder.hax.answers
    }),type:"Message.TeamTalk"});
    if(k.parent.options.teamtalk && !k.parent.options.manual){
      const start = k.parent.options.timeout * 1000 + (Number(k.parent.options.variableTimeout) * Math.random() * 1000);
      const end = Math.random() * ((Number(k.parent.options.timeoutEnd) - (start/1000) || 0)) * 1000;
      k.parent.teamAnswered = true;
      k.parent.waiter = setTimeout(()=>{
        QuestionAnswer(k,q);
      },start + end);
    }
  },
  NameAccept: (k,n)=>{
    k.parent.send({message:JSON.stringify(n),type:"Message.NameAccept"});
  },
  GameReset: k=>{
    k.parent.send({message:"The Game Reset.",type:"Message.GameReset"});
  }
};
function applyListeners(kahoot){
  kahoot.list = {};
  for(let i in Listeners){
    const l = info=>{
      Listeners[i](kahoot,info);
    };
    kahoot.on(i,l);
    kahoot.list[i] = l;
  }
}
const BruteForces = [[0,1,2,3],[0,1,3,2],[0,2,1,3],[0,2,3,1],[0,3,2,1],[0,3,1,2],[1,0,2,3],[1,0,3,2],[1,2,0,3],[1,2,3,0],[1,3,0,2],[1,3,2,0],[2,0,1,3],[2,0,3,1],[2,1,0,3],[2,1,3,0],[2,3,0,1],[2,3,1,0],[3,0,1,2],[3,0,2,1],[3,1,0,2],[3,1,2,0],[3,2,0,1],[3,2,1,0]];

// silly paths.
app.get("/up",(req,res)=>{
  const end = startupDate + (12 * 60 * 60 * 1000);
  const minutes = Math.round((end - Date.now()) / (1000 * 60));
  let message = "";
  if(minutes > 60){
    message = Math.round(minutes / 60) + " hours until expected reset.";
  }else{
    message = minutes + " minutes until expected reset.";
  }
  message += " : v" + appInformation.version;
  res.send(message);
});
app.get(/ext\/?https?:\/\/.*\.(google|gstatic|facebook|fb).*\.(com|net)\/.*/i,(req,res)=>{
  const url = req.url.split("/ext/").slice(1).join("/ext/");
  request(url,(e,r,b)=>{
    if(e){
      res.status(404);
      res.end();
      return;
    }
    res.status(r.statusCode);
    res.setHeader("Cache-Control","public, max-age=31622400");
    let d = new Date;
    d.setYear(d.getFullYear() + 1);
    res.setHeader("Expires", d.toUTCString());
    res.setHeader("Content-Type",r.headers["content-type"] || "text/html");
    res.send(b);
  });
});
app.get("/creator",(req,res)=>{
  res.redirect("https://kahoot-win.herokuapp.com/creator");
});
app.get("/how-it-works",(req,res)=>{
  res.redirect("https://kahoot-win.herokuapp.com/how-it-works");
});
app.get("/api",(req,res)=>{
  res.redirect("https://kahoot.js.org");
});
app.get(/\/blog\/?.*?/i,(req,res)=>{
  res.redirect("https://kahoot-win.herokuapp.com" + req.url);
});

// 404 Page
app.use((req,res)=>{
  res.status(404);

  // respond with html page
  if (req.accepts("html")) {
    res.sendFile(path.join(__dirname,"public","404.html"));
    return;
  }

  // respond with json
  if (req.accepts("json")) {
    res.send(JSON.stringify({error:"Not found",message:"Visit https://kahoot-win.herokuapp.com",status:404}));
    return;
  }

  // default to plain-text. send()
  res.type("txt").send("[404] I think you made a typo! Try going to https://kahoot-win.herokuapp.com/");
});

if(!process.argv.includes("--disable-electron")){
  function createWindow () {
    // Create the browser window.
    let win = new electron.BrowserWindow({
      width: 1100,
      height: 750,
      webPreferences: {
        nodeIntegration: true
      }
    });

    // and load the index.html of the app.
    win.loadURL("http://localhost:2000");

    win.on("close",async evt=>{
      const {response} = await electron.dialog.showMessageBox({
        buttons: ["No","Yes"],
        message: "Are you sure you want to close the app?",
        title: "Exit app"
      });
      if(response === 1){
        win.destroy();
      }else{
        evt.preventDefault();
      }
    });
  }

  // Check latest version with live site
  request("https://kahoot-win.herokuapp.com/up",async (e,r,b)=>{
    if(e){
      return console.log("Error fetching latest version information");
    }
    if(b && typeof b === "string"){
      if(b.includes(require("./package.json").version)){
        console.log("Client is up to date.");
      }else{
        console.log("Client is not up to date.");
        const {response} = await electron.dialog.showMessageBox({
          buttons: ["Later","Update"],
          message: `An update is available [v${b.match(/(?<=v)\d+\.\d+\.\d+/)[0]}]. Currently using v${require("./package.json").version} Would you like to download it now?`,
          title: "New Version"
        });
        if(response === 1){
          electron.shell.openExternal("https://kahoot-win.herokuapp.com/blog/download");
          electron.app.exit(0);
        }
      }
    }
  });

  electron.app.whenReady().then(createWindow);

  electron.app.on("window-all-closed", () => {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== "darwin") {
      electron.app.quit();
    }
  });

  electron.app.on("activate", () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}
