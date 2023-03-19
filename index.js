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
  const topLevelGoal =
    "Parameterize the `topLevelGoal` so that we can pass it in as a node js argument";

  const branch = await getBranchName({ topLevelGoal });

  let gameplan = "Inspect index.js and figure out where to go from there.";
  let workingFile = "";
  let commandOutputs = executeCommands(["ls", "cat index.js"]);

  // git checkout branch
  console.log(`Checking out a new branch ${branch}`);
  execSync(`git checkout -b ${branch}`, { encoding: "utf-8" });

  const iteration = 0;
  while (iteration < MAX_ITERATIONS) {
    console.log(`Starting iteration ${iteration}`);
    let { patch, patchDescription, nextIteration, complete } = await iterate({
      topLevelGoal,
      gameplan,
      commandOutputs,
      workingFile,
    });

    // log response to patch file
    logIteration(directory, branch, iteration, {
      patch,
      patchDescription,
      nextIteration,
      complete,
    });

    if (patch) {
      applyPatch(directory, branch, iteration, patch);
    }

    if (complete) {
      console.log(`Top Level Task completed on iteration ${iteration}`);
      break;
    }

    if (nextIteration?.commands) {
      commandOutputs = executeCommands(commands);
    }

    if (nextIteration?.workingFile) {
      const workingFilePath = path.join(directory, workingFile);
      workingFile = fs.readFileSync(workingFilePath, "utf-8");
    }

    if (nextIteration?.gameplan) {
      gameplan = nextIteration.gameplan;
    }

    iteration++;
  }

  const { commitMessage } = await getCommitMessage();
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
      console.warn(`Attempt to execute command ${command} was blocked`);
      continue;
    }

    console.log(`!!!!!!!!!!!! Executing command !!!!!!!!!!!!`);
    console.log(command);
    console.log(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);

    const output = execSync(command, { encoding: "utf-8" });
    commandOutputs[command] = output;
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

  execSync(`git apply --reject --whitespace=fix ${patchPath}`, {
    encoding: "utf-8",
  });
}

function logIteration(directory, branch, iteration, response) {
  const iterationLogPath = path.join(
    directory,
    ".gpt-git",
    branch,
    `${iteration}`,
    "response.json"
  );
  fs.ensureFileSync(iterationLogPath);
  fs.writeFileSync(
    iterationLogPath,
    JSON.stringify(response, null, 2),
    "utf-8"
  );
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

async function iterate({
  topLevelGoal,
  gameplan,
  commandOutputs,
  workingFile,
}) {
  let workingFileContent = workingFile
    ? fs.readFileSync(workingFile, "utf-8")
    : "<no working file selected>";

  const gitStatusCommand = "git status --short";
  const gitStatus = execSync(gitStatusCommand, { encoding: "utf-8" });

  const gitTreeCommand = "git ls-tree -r --name-only HEAD";
  const gitTree = execSync(gitTreeCommand, { encoding: "utf-8" });

  const readme = fs.readFileSync("README.md", "utf-8");

  const formattedCommandOutputs = Object.entries(commandOutputs).reduce(
    (acc, [command, output]) => {
      return `${acc}\n\n>>>>>>>>>> ${command}\n\`\`\`\n${output}\n\`\`\`\n`;
    },
    ""
  );

  const systemPrompt = `As GPT-4, you are an expert in software architecture, development, and analysis.\n
    You are presented with a Top Level Goal for which we need to make changes to the repository.\n\n
    You're given an immediate Gameplan which you will act on and later modify.\n\n
    You're given the opportunity to iterate on the changes, so you may be presented with a repository that is already mid-change with a partially-executed Gameplan.\n\n
    
    You are given plenty of Relevant Context about the Repository including:\n
    * Repository README: a description of the repository which should give context about technologies, patterns, uses, and test commands\n
    * a Git Status: the current working tree status,\n
    * a Git Tree: the current git tree which shows all working files\n
    * Command Stdout/StdErr: commands paired with their StdOut/StdErr\n

    You are given the following Working File Context:\n
    * Working File: the full contents of the working file\n
    * Working File Context: peaks into summaries of files related to the working file\n\n
    
    You recommend a series of changes as a \`patch\`. Respond only with a valid JSON Object. Escape any characters that need to be escaped.
`;

  const userPrompt = `### Top Level Goal\n\n
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

    ### Command Stdout/StdErr\n
    ${formattedCommandOutputs}\n\n

    ### Working File\n
    ${workingFileContent}\n\n
    ================== End Relevant Context ==================\n\n

    It is now your job to make specific improvements and modifications according to the initial request. Consider the changes you are sure you want to make given what you know about the repository.\n\n

    {\n
        "patch": \${a series of code changes in the form of a \`patch\` diff using the unified diff format (generated using git diff or diff -u). If no changes are needed, return an empty string. Though typically the patch is applied to the Working File, the patch may contain changes to more than one file or even create new files or delete existing files.},\n
        "patchDescription": \${a concise, accurate description of the changes in the patch. This is a human readable description of the changes.},\n
        "nextIteration": {\n
            "gameplan": \${the above given Gameplan, modified to reflect only the remaining steps required to achieve the Top Level Goal after applying the above patch.},\n
            "commands": [\${one or more commands we should run after applying the above patch in service of learning about how to best apply the next Gameplan. Use commands like \`ls\` \`grep\`, \`cat\`, \`npm run test\`, \`npm run lint\`, and \`git\` to inspect the current state of the repository, search for terms, read files and directories, and run tests to see if the codebase is consistent. Be mindful of output format, run only commands that are immediately useful, keep them targetted. Configure commands to return only the necessary information to conserve space.}],\n
            "workingFile": \${the path of the next Working File we should open after applying the above patch in order to achieve the Top Level Goal.},\n
        },\n
        "complete": \${\`true\` if you are confident that you have completed the Top Level Goal. \`false\` if you are not confident that you have completed the Top Level Goal. This is exlusive with the \`nextIteration\` field.}\n
    }\n
`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const response = await chat(messages);

  const { patch, patchDescription, nextIteration, complete } =
    JSON.parse(response);

  return {
    patch,
    patchDescription,
    nextIteration,
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

  const response = await chat(messages, "gpt-3.5-turbo");

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

  const response = await chat(messages, "gpt-3.5-turbo");

  const { commitMessage } = JSON.parse(response);
  return { commitMessage };
}

async function getBranchName({ topLevelGoal }) {
  const systemPrompt = `You are a helpful, accurate, knowledgable software engineer.`;

  const userPrompt = `### Top Level Goal\n\n
    ${topLevelGoal}\n\n

    We need a git branch name that reflects the above goal. Recommend a git branch name using kebab-case, keep it longer than 20 characters. Respond only with the text of the branch name with no description or other delimiters.
  `;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const response = chat(messages, "gpt-3.5-turbo");
  return `${response}-${Math.floor(Math.random() * 100000)}`;
}

async function chat(messages, model = "gpt-4") {
  console.log(
    `=====================local to ${model}>>>>>>>>>>>>>>>>>>>>>\n${JSON.stringify(
      messages,
      null,
      2
    )}\n========================================================`
  );
  const response = await openai.createChatCompletion({
    model,
    messages,
    temperature: 1,
    n: 1,
  });

  const content = response.data.choices[0].message.content;

  console.log(
    `<<<<<<<<<<<<<<<<<<<<<<${model} to local:=====================\n${content}\n========================================================`
  );

  return content;
}

main()
  .then(() => console.log("Success!"))
  .catch((error) => console.error("Error:", error));
