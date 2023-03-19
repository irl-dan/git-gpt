const fs = require("fs-extra");
const path = require("path");
const { execSync } = require("child_process");
const dotenv = require("dotenv");
const { Octokit } = require("@octokit/rest");
const { Configuration, OpenAIApi } = require("openai");

dotenv.config();
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

const UNIQUE_DELIMITER = "|||GPT4_DELIMITER|||";
const octokit = new Octokit({ auth: process.env.GITHUB_ACCESS_TOKEN });
const MAX_ITERATIONS = 20;

async function main() {
  const directory = process.cwd();

  const context =
    "You are working on a pull request for a project. You are midway through making changes according to the following Planned Changes. Included below is helpful context about the changes and the state of the code repository.";
  const topLevelGoal =
    "Parameterize the request so that we can pass it in as an argument";

  const { branchName } = await getBranchName({ topLevelGoal });

  // git checkout branch
  console.log(`Checking out a new branch ${branchName}`);
  execSync(`git checkout -b ${branchName}`, { encoding: "utf-8" });

  const iteration = 0;
  while (iteration < MAX_ITERATIONS) {
    console.log(`Starting iteration ${iteration}`);
    const {
      patch,
      patchDescription,
      gameplan,
      commands,
      workingFile,
      complete,
    } = await iterate({
      topLevelGoal,
      gameplan,
      readContents,
      fileContent,
      commandOutputs,
    });

    // log response to patch file
    logIteration(directory, branchName, iteration);

    if (complete) {
      console.log(`Top Level Task completed on iteration ${iteration}`);
      break;
    }

    if (patch) {
      applyPatch(directory, branchName, iteration, patch);
    }

    if (patchDescription) {
      plannedChanges += patchDescription;
    }

    if (commands) {
      commandOutputs = executeCommands(commands);
    }

    if (workingFile) {
      const workingFilePath = path.join(directory, workingFile);
      const workingFileContent = fs.readFileSync(workingFilePath, "utf-8");
    }

    iteration++;
  }

  const { commitMessage } = await getCommitMessage();
  const { changeLog } = await getChangeLog();

  logCommit(directory, branchName, changeLog);

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
    const output = execSync(command, { encoding: "utf-8" });
    commandOutputs[command] = output;
  }
  return commandOutputs;
}

function applyPatch(directory, branchName, iteration, patch) {
  const patchPath = path.join(
    directory,
    ".gpt-git",
    branchName,
    iteration,
    "patch"
  );
  fs.ensureFileSync(patchPath);
  fs.writeFileSync(patchPath, patch, "utf-8");

  execSync(`git apply --reject --whitespace=fix ${patchPath}`, {
    encoding: "utf-8",
  });
}

function logIteration(directory, branchName, iteration) {
  const iterationLogPath = path.join(
    directory,
    ".gpt-git",
    branchName,
    iteration,
    "response.json"
  );
  fs.ensureFileSync(iterationLogPath);
  fs.writeFileSync(
    iterationLogPath,
    JSON.stringify(response, null, 2),
    "utf-8"
  );
}

function logCommit(directory, branchName, changeLog) {
  const changeLogPath = path.join(
    directory,
    ".gpt-git",
    branchName,
    "CHANGE_LOG.md"
  );
  fs.ensureFileSync(changeLogPath);
  fs.writeFileSync(changeLogPath, changeLog, "utf-8");
}

async function iterate({
  topLevelGoal,
  gameplan,
  readContents,
  fileContent,
  commandOutputs,
}) {
  const gitStatusCommand = "git status --short";
  const gitStatus = execSync(gitStatusCommand, { encoding: "utf-8" });

  const gitTreeCommand = "git ls-tree -r --name-only HEAD";
  const gitTree = execSync(gitTreeCommand, { encoding: "utf-8" });

  const readme = fs.readFileSync("README.md", "utf-8");

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
    ${commandOutputs}\n\n

    ### Relevant Context\n
    ${readContents}\n\n

    ### Working File\n
    ${fileContent}\n\n

    ### Working File Context\n
    ${fileContent}\n\n
    ================== End Relevant Context ==================\n\n

    It is now your job to make specific improvements and modifications according to the initial request. Consider the changes you are sure you want to make given what you know about the repository.\n\n

    {\n
        "patch": \${a series of code changes in the form of a \`patch\` diff using the unified diff format (generated using git diff or diff -u). If no changes are needed, return an empty string. Though typically the patch is applied to the Working File, the patch may contain changes to more than one file or even create new files or delete existing files.},\n
        "patchDescription": \${a concise, accurate description of the changes in the patch. This is a human readable description of the changes.},\n
        "nextIteration": {\n
            "gameplan": \${the above given Gameplan, modified to reflect only the remaining steps required to achieve the Top Level Goal after applying the above patch.},\n
            "commands": [\${one or more commands we should run after applying the above patch in service of learning about how to best apply the next Gameplan. Use commands like \`ls\` \`grep\`, \`cat\`, \`npm run test\`, \`npm run lint\`, and \`git\` to inspect the current state of the repository, search for terms, read files and directories, and run tests to see if the codebase is consistent. Be mindful of output format, run only commands that are immediately useful, keep them targetted. Configure commands to return only the necessary information to conserve space.}],\n
            "workingFile": \${the next Working File we should open after applying the above patch in order to achieve the Top Level Goal.},\n
        },\n
        "complete": \${\`true\` if you are confident that you have completed the Top Level Goal. \`false\` if you are not confident that you have completed the Top Level Goal. This is exlusive with the \`nextIteration\` field.}\n
    }\n
`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const response = chat(messages);

  const {
    patch,
    patchDescription,
    nextIteration: { gameplan, commands, workingFile },
    complete,
  } = JSON.parse(response);

  return {
    patch,
    patchDescription,
    gameplan,
    commands,
    workingFile,
    complete,
  };
}

async function getCommitDescription({ topLevelGoal }) {
  const gitDiffCommand = "git diff";
  const gitDiff = execSync(gitDiffCommand, { encoding: "utf-8" });

  const userPrompt = `### Top Level Commit Goal\n\n
    ${topLevelGoal}\n\n

    ### Commit Diff\n
    > ${gitDiffCommand}\n
    \`\`\`\n
    ${gitDiff}\n
    \`\`\`\n\n

    Recommend a concise but accurate commit message for the above diff. Respond in the following template:
    {\n
        "commitMessage": \${concise but accurate commit message that summarizes the above diff into a single, easy to parse sentence no more than 72 characters long.},\n
    }\n
  `;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const response = chat(messages);

  const { commitMessage } = JSON.parse(response);
  return { commitMessage };
}

async function getChangeLog({ topLevelGoal }) {
  const gitDiffCommand = "git diff";
  const gitDiff = execSync(gitDiffCommand, { encoding: "utf-8" });

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

  const response = chat(messages);

  const { commitMessage } = JSON.parse(response);
  return { commitMessage };
}

async function getBranchName({ topLevelGoal }) {
  const userPrompt = `### Top Level Goal\n\n
    ${topLevelGoal}\n\n

    We're going to work on the above goal in a git branch. Recommend a git branch name. Respond in the following template:
    {\n
        "branchName": \${Recommend a specific git branch name that corresponds to the Top Level Goal. Use kebab case, use at least 30 characters},\n
    }\n
  `;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const response = chat(messages);

  const { branch } = JSON.parse(response);
  return { branch };
}

async function chat(messages) {
  console.log(
    `=====================Local to GPT-4>>>>>>>>>>>>>>>>>>>>>\n\n${JSON.stringify(
      messages,
      null,
      2
    )}========================================================`
  );
  const response = await openai.createChatCompletion({
    model: "gpt-4",
    messages,
    temperature: 1,
    n: 1,
  });

  const content = response.data.choices[0].message.content;

  console.log(
    `<<<<<<<<<<<<<<<<<<<<<<GPT-4 to Local:\n\n=====================${content}========================================================`
  );

  return content;
}

async function changeSingleFile(markdown) {
  const systemPrompt =
    "As GPT-4, you are an expert in software development and code analysis. Follow the request at the bottom to provide insightful recommendations and helpful fixes for the code. Make changes to files only when it is essential for improving the code quality or fixing issues.";

  const userPrompt = `Given the stuffed markdown context:

  ### Context\n
  ${context}\n\n
  
  ### Planned Changes\n
  ${plannedChanges}\n\n
  
  ### Git Status\n
  ${gitStatus}\n\n

  ### Git Tree\n
  ${gitTree}\n\n

  ### Relevant Context\n
  ${readContents}\n\n

  ### Working File\n
  ${fileContent}\n\n

  ### Request\n
  ${request}

Carefully analyze the code and provide a recommended file change that addresses any issues, optimizes the code, or enhances its functionality. Ensure that your recommendations are precise, relevant, and actionable. Respond with the new file contents, followed by the unique delimiter:

${UNIQUE_DELIMITER}

Then, provide a compact pseudocode interface summary of the new version of the file, including public classes, method signatures, exported function signatures, and any other useful information for an external file import. This summary should be as compact as possible while still giving insight into the public-facing interfaces within the file.`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  return chat(messages);
}

async function createPullRequest(owner, repo, head, base, title, body) {
  try {
    const response = await octokit.rest.pulls.create({
      owner,
      repo,
      head,
      base,
      title,
      body,
    });

    if (response.status === 201) {
      console.log(
        `Pull request created successfully: ${response.data.html_url}`
      );
      return response.data.html_url;
    } else {
      console.error("Error creating pull request:", response);
      return null;
    }
  } catch (error) {
    console.error("Error creating pull request:", error);
    return null;
  }
}

main()
  .then(() => console.log("Success!"))
  .catch((error) => console.error("Error:", error));
