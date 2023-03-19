const fs = require("fs-extra");
const path = require("path");
const { execSync } = require("child_process");
const dotenv = require("dotenv");
const { Configuration, OpenAIApi } = require("openai");

dotenv.config();
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

const MAX_ITERATIONS = 20;

async function main() {
  const directory = process.cwd();
  const topLevelGoal = process.argv[2];

  const { branch } = await getBranchName({ topLevelGoal });

  let gameplan = "Inspect index.js and figure out where to go from there.";
  let workingFile = "";

  console.log(`Top Level Goal: ${topLevelGoal}`);
  // git checkout branch
  console.log(`Checking out a new branch ${branch}`);
  execSync(`git checkout -b ${branch}`, { encoding: "utf-8" });

  const iteration = 0;
  while (iteration < MAX_ITERATIONS) {
    console.log(`Starting iteration ${iteration}`);
    let { patch, nextGameplan, commandOutputs, complete } = await iterate({
      topLevelGoal,
      gameplan,
    });

    logIteration(directory, branch, iteration, {
      patch,
      nextGameplan,
      commandOutputs,
      complete,
    });

    if (patch) {
      applyPatch(directory, branch, iteration, patch);
    }

    if (complete) {
      console.log(`Top Level Task completed on iteration ${iteration}`);
      break;
    }

    if (nextGameplan) {
      gameplan = nextGameplan;
    }

    iteration++;
  }

  const { commitMessage } = await getCommitMessage({ topLevelGoal });
  const { changeLog } = await getChangeLog();

  logCommit(directory, branch, changeLog);

  console.log("Committing changes and creating a new branch");

  try {
    console.log("Adding changes to the staging area");
    execSync("git add .", { encoding: "utf-8" });

    console.log(`Committing the changes with message "${commitMessage}"`);
    execSync(`git commit -m "${commitMessage}"`, { encoding: "utf-8" });
  } catch (error) {
    console.error(
      "Error while committing changes and creating a new branch:",
      error
    );
  }
}

function executeCommands(commands) {
  const commandOutputs = {};
  // limit to `grep`, `ls`, `cat`, `npm run test`, `npm run lint`, `git`
  for (const command of commands) {
    if (
      !command.startsWith("grep") &&
      !command.startsWith("ls") &&
      !command.startsWith("cat") &&
      !command.startsWith("npm run test") &&
      !command.startsWith("npm run lint") &&
      !command.startsWith("git")
    ) {
      console.warn(`Attempt to execute command \`${command}\` was blocked`);
      continue;
    }

    console.log(`!!!!!!!!!!!! Executing command !!!!!!!!!!!!`);
    console.log(command);
    console.log(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);

    try {
      const output = execSync(command, { encoding: "utf-8" });
      commandOutputs[command] = output;
    } catch (error) {
      if (error.stderr) {
        commandOutputs[command] = error.stderr.toString();
      } else {
        commandOutputs[command] = error.toString();
      }
    }
  }
  return commandOutputs;
}

function applyPatch(directory, branch, iteration, patch) {
  const patchPath = path.join(
    directory,
    ".gpt-git",
    branch,
    `${iteration}`,
    "patch"
  );
  fs.ensureFileSync(patchPath);
  fs.writeFileSync(patchPath, patch, "utf-8");

  try {
    execSync(`git apply --reject --whitespace=fix ${patchPath}`, {
      encoding: "utf-8",
    });
  } catch (error) {
    console.warn("Error while applying patch:", error);
  }
}

function logIteration(
  directory,
  branch,
  iteration,
  { patch, nextGameplan, commandOutputs, complete }
) {
  if (patch) {
    const patchFilePath = path.join(
      directory,
      ".gpt-git",
      branch,
      `${iteration}`,
      "patch"
    );
    fs.ensureFileSync(patchFilePath);
    fs.writeFileSync(patchFilePath, patch, "utf-8");
  }

  if (nextGameplan) {
    const nextGameplanPath = path.join(
      directory,
      ".gpt-git",
      branch,
      `${iteration}`,
      "nextGameplan.md"
    );
    fs.ensureFileSync(nextGameplanPath);
    fs.writeFileSync(nextGameplanPath, nextGameplan, "utf-8");
  }

  if (commandOutputs) {
    const commandOutputsPath = path.join(
      directory,
      ".gpt-git",
      branch,
      `${iteration}`,
      "out.log"
    );
    fs.ensureFileSync(commandOutputsPath);
    fs.writeFileSync(commandOutputsPath, commandOutputs, "utf-8");
  }

  if (complete) {
    const completePath = path.join(
      directory,
      ".gpt-git",
      branch,
      `${iteration}`,
      "out.log"
    );
    fs.ensureFileSync(completePath);
    fs.writeFileSync(completePath, `${complete}`, "utf-8");
  }
}

function logCommit(directory, branch, changeLog) {
  const changeLogPath = path.join(
    directory,
    ".gpt-git",
    branch,
    "CHANGE_LOG.md"
  );
  fs.ensureFileSync(changeLogPath);
  fs.writeFileSync(changeLogPath, changeLog, "utf-8");
}

// todo:

// break `iterate` into a chat series:

// 1. "here is the context"
// 2. run any commands you wish, you will be constrained by stdout size, so be targeted
// 3. decide on patch
// 4. decide on immediate next gameplan

async function iterate({ topLevelGoal, gameplan }) {
  const systemPrompt = `As GPT-4, you are an expert in software architecture, development, and analysis.\n
    You are presented with a Top Level Goal, and you have access to a git repository, which you are permitted to modify through \`patch\` commands. You aim to change the state of the repository to advance the Top Level Goal.\n
    You do nothing beyond recommending patches to the git repository that advance the Top Level Goal, while keeping the repository secure, compliant, safe, robust, modular, and easy-to-read.\n
    You often recommend patches that are not immediately obvious to the human developer, but you are able to see the big picture and make the right decisions.\n
    You recommend patches that are not only correct, but also the most efficient, the most secure, the most compliant, the most robust, the most modular, and the most easy-to-read.\n\n
    
    To aid you in advancing the Top Level Goal, you're presented with an immediate Gameplan which you will act on and later modify. (Top Level Goal:Strategy::Gamplan:Tactics)\n\n
    
    You are given plenty of Relevant Context about the Repository including:\n
    * Repository README: a description of the repository which should give context about technologies, patterns, uses, and test commands\n
    * a Git Status: the current working tree status,\n
    * a Git Tree: the current git tree which shows all working files\n

    Whenever you are asked to run a command, you will be constrained by stdout/stderr size, so be targeted. Optimize toward making the best patch decision, but use no more stdout/stderr than you require so avoid verbose output formats, and run only commands that are immediately useful.\n\n
    You may use any one of the the following commands, but you are limited to running only the following commands. You may not run a command that modifies any state of the repository: \`ls\` \`grep\`, \`cat\`, \`git\`, \`tail\`, \`head\`, \`find\`, \`npm run test\`, \`npm run lint\`.\n\n
    
    When asked to recommend a series of changes, use write a valid \`patch\` diff using the unified diff format (ie what is generated using git diff or diff -u).
    It is okay if your patch may not perfectly advance the Gameplan or reach the Top Level Goal, as you will have a future opportunity to iterate on it again in the future. But it should aim to make as much progress as possible.\n\n

    When asked to modify the gameplan for the future iteration, you are sure to re-consider the Top Level Goal now that the previous patch has been applied. Be sure to remove any items that have been accomplished, add commands for testing the patch, and add new items to the gameplan that are now possible.\n\n
  `;

  const gitStatusCommand = "git status --short";
  const gitStatus = execSync(gitStatusCommand, { encoding: "utf-8" });

  const gitTreeCommand = "git ls-tree -r --name-only HEAD";
  const gitTree = execSync(gitTreeCommand, { encoding: "utf-8" });

  const readme = fs.readFileSync("README.md", "utf-8");

  const contextMessage = `### Top Level Goal\n\n
    ${topLevelGoal}

    ### Gameplan\n
    ${gameplan}\n\n

    ================== Begin Relevant Context ==================\n\n
    ### Repository README\n
    > cat README.md\n
    \`\`\`\n
    ${readme}\n
    \`\`\`\n\n

    ### Git Repository Status\n
    > ${gitStatusCommand}\n
    \`\`\`\n
    ${gitStatus}\n
    \`\`\`\n\n

    ### Git Tree\n
    > ${gitTreeCommand}\n
    \`\`\`\n
    ${gitTree}\n
    \`\`\`\n
    ================== End Relevant Context ==================\n\n

    It is now your job to make specific improvements and modifications according to the initial request. Consider the changes you are sure you want to make given what you know about the repository.\n\n

    Specify one or more commands to run, like \`ls\` \`grep\`, \`cat\`, \`git\`, \`tail\`, \`head\`, \`find\`, \`npm run test\`, \`npm run lint\` in service of learning about the repository in order to best apply a patch.

    Respond with a JSON string array of commands to run, like: ["grep -Hn <search> *", "cat index.js"].\n\n
`;

  let messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: contextMessage, name: "context-provider" },
  ];

  const commandsResponse = await chatMany(messages);

  let commands;
  try {
    commands = JSON.parse(commandsResponse?.content);
  } catch (e) {
    console.warn(`Failed to parse commands: ${commandsResponse?.content}`);
    throw e; // TODO: we can suppress this later and prompt to reformat
  }

  if (commands) {
    commandOutputs = executeCommands(commands);
  }

  let commandOutputsContent;
  if (!commandOutputs) {
    commandOutputsContent = "<no commands were run>";
  } else {
    commandOutputsContent = Object.entries(commandOutputs).reduce(
      (acc, [command, output]) => {
        return `${acc}\n\n>>>>>>> shell >>>>>>>>\n$ ${command}\n${output}\n<<<<<<< shell <<<<<<<`;
      },
      ""
    );
  }

  const patchRequestContent = `
    As a helpful, accurate, knowledgable software engineer, you are now ready to make specific improvements and modifications according to the Top Level Goal, the Gameplan, and what you know about the repository. Make as many changes to as many files as you wish. Create new files, delete existing ones, or move files.\n\n
    Specify the changes you want to make using a \`patch\` diff using the unified diff format (ie to be used by \`git apply <patch>\`).\n\n

    The patch file consists of several sections called 'hunks', each representing a set of changes made to a specific part of the file. The format and structure of a patch file is as follows:

    ================== Begin Patch Format Documentation ==================\n\n
    ### Header\n\n
    The header contains two lines, each starting with either "---" or "+++". The "---" line refers to the original file, and the "+++" line refers to the modified file. The file paths or names are provided after the "---" and "+++" symbols.\n
    Example:\n
    \`\`\`\n
    --- app_original.py\n
    +++ app_modified.py\n
    \`\`\`\n\n
    ### Hunk\n\n
    A hunk represents a set of changes made to a specific part of the file, containing both context lines and the actual changes. A hunk starts with a line that begins with "@@" and has the format:\n
    \`\`\`\n
    @@ -start1,count1 +start2,count2 @@
    \`\`\`\n
    The start1 and count1 refer to the line number and the number of lines in the original file, while start2 and count2 refer to the line number and the number of lines in the modified file. This line is followed by the actual changes and context lines.\n\n

    ### Changes\n\n
    Each line within a hunk starts with one of the following symbols, indicating its purpose:\n
    ' ': A space character indicates a context line, meaning the line is unchanged and provides context for the surrounding changes.\n
    '-': A minus symbol indicates a line that has been removed from the original file.\n
    '+': A plus symbol indicates a line that has been added to the modified file.\n
    Example:\n
    \`\`\`\n
    @@ -5,6 +5,10 @@\n
    def home():\n
        return render_template('index.html')\n\n

    +@app.route('/about')\n
    +def about():\n
    +    return render_template('about.html')\n
    +\n
    if __name__ == '__main__':\n
        app.run(debug=True)\n
    \`\`\`\n\n
    In this example, the hunk starts at line 5 in both the original and modified files. The original file has 6 lines in this section, while the modified file has 10 lines. The actual changes are the addition of the lines marked with '+'.
    
    ================== End Patch Format Documentation ==================\n\n

    If no changes are needed, return an empty string. Respond only with contents of the patch, without any surrounding context, explanation, delimiters, or other information. Do not surround with code quote strings or with markdown. Avoid any patches that would return "corrupt patch at line N".
    `;

  const commandOutputsMessage = {
    role: "user",
    content: commandOutputsContent,
    name: "console",
  };
  const patchRequestMessage = {
    role: "user",
    content: patchRequestContent,
    name: "project-manager",
  };
  messages = [
    ...messages,
    // commandsResponse,
    commandOutputsMessage,
    patchRequestMessage,
  ];

  const patchResponse = await chatMany(messages);
  const patch = patchResponse?.content;

  const nextGameplanContent = `
    Consider the above patch and make updates to the Gameplan for future iterations. Be sure to re-consider the Top Level Goal now that the previous patch has been applied. Be sure to remove any items that are no longer required given the patch, add commands for testing the patch, and add new items to the gameplan that are now possible. A good gameplan is typically outlined in bullet format.\n\n
    If the Top Level Goal has been achieved or is close enough to being achieved that no further steps are necessary, return the precise valid JSON Object: \`{ "topLevelComplete": true }\`, with no words, explanation, or padding accompanying it.\n\n

    ### Top Level Goal:\n
    ${topLevelGoal}\n\n
    
    ### Current Gameplan:\n
    ${gameplan}\n\n

    ### New Gameplan:
    `;

  const nextGameplanMessage = {
    role: "user",
    content: nextGameplanContent,
    name: "project-manager",
  };
  messages = [...messages, patchResponse, nextGameplanMessage];

  const nextGameplanResponse = await chatMany(messages);
  const nextGameplan = nextGameplanResponse?.content;

  let complete = false;
  try {
    const { topLevelComplete } = JSON.parse(nextGameplan.trim());
    complete = topLevelComplete;
  } catch (e) {}

  return {
    patch,
    commandOuputs: commandOutputsContent,
    nextGameplan,
    complete,
  };
}

async function getCommitMessage({ topLevelGoal }) {
  const gitDiffCommand = "git diff";
  const gitDiff = execSync(gitDiffCommand, { encoding: "utf-8" });

  const systemPrompt = `You are a helpful, accurate, knowledgable technical writer.`;

  const userPrompt = `### Top Level Commit Goal\n\n
    ${topLevelGoal}\n\n

    ### Commit Diff\n
    > ${gitDiffCommand}\n
    \`\`\`\n
    ${gitDiff}\n
    \`\`\`\n\n

    Recommend a concise but accurate commit message for the above diff. Respond only with a valid JSON Object. Escape any characters that need to be escaped. Format the response according to the following template:\n\n
    {\n
        "commitMessage": \${concise but accurate commit message that summarizes the above diff into a single, easy to parse sentence no more than 72 characters long.},\n
    }\n
  `;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const response = await chatOne(messages, "gpt-3.5-turbo");

  const { commitMessage } = JSON.parse(response);
  return { commitMessage };
}

async function getChangeLog({ topLevelGoal }) {
  const gitDiffCommand = "git diff";
  const gitDiff = execSync(gitDiffCommand, { encoding: "utf-8" });

  const systemPrompt = `You are a helpful, accurate, knowledgable technical writer.`;

  const userPrompt = `### Top Level Commit Goal\n\n
    ${topLevelGoal}\n\n

    ### Commit Diff\n
    > ${gitDiffCommand}\n
    \`\`\`\n
    ${gitDiff}\n
    \`\`\`\n\n

    Recommend a concise but accurate change log that highlights important/breaking/notable changes in a detailed markdown document using the below sections. Use bullets and code snippets if it would help to illustrate. If there is no content for a given section, write 'N/A':\n
    #### Breaking Changes\n
    #### New Features\n
    #### Bug Fixes\n
  `;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const response = await chatOne(messages, "gpt-3.5-turbo");

  const { commitMessage } = JSON.parse(response);
  return { commitMessage };
}

async function getBranchName({ topLevelGoal }) {
  const systemPrompt = `You are a helpful, accurate, knowledgable software engineer. You respond only with a valid JSON Object. Escape any characters that need to be escaped.`;

  const userPrompt = `### Top Level Goal\n\n
    ${topLevelGoal}\n\n

    We need a git branch name that reflects the above goal. Recommend a git branch name following the JSON template below. Respond only with the JSON and nothing else:\n\n
    {\n
        "branch": \${branchName}\n
    }\n
  `;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // const response = await chat(messages, "gpt-3.5-turbo");

  // random branch name
  const branch = `branch-${Math.random().toString(36).substr(2, 9)}`;

  // const { branch } = JSON.parse(response);
  return { branch };
}

async function chatOne(messages, model = "gpt-4") {
  const message = await chatMany(messages, model);

  return message?.content;
}

async function chatMany(messages, model = "gpt-4") {
  console.log(
    `=====================Local to GPT-4>>>>>>>>>>>>>>>>>>>>>\n${JSON.stringify(
      messages,
      null,
      2
    )}\n========================================================`
  );
  let response;
  // sleep for 5 seconds to avoid rate limiting
  await new Promise((resolve) => setTimeout(resolve, 6000));
  try {
    response = await openai.createChatCompletion({
      model,
      messages,
      temperature: 1,
      n: 1,
    });
  } catch (e) {
    if (e.response) {
      console.error(e.response.data);
    }
    throw e;
  }

  const message = response.data.choices[0].message;

  console.log(
    `<<<<<<<<<<<<<<<<<<<<<<GPT-4 to Local:=====================\n${JSON.stringify(
      message
    )}\n========================================================`
  );

  return message;
}

main()
  .then(() => console.log("Success!"))
  .catch((error) => console.error("Error:", error))
  .finally(() => {
    execSync("git checkout main", { encoding: "utf-8" });
  });
